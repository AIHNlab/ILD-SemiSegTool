"""Trachea/carina split pipeline (rule-based, no retraining) for ATM airway masks.

Coordinate convention: NIfTI orientation codes for this data are confirmed (L, P, S) —
i.e. increasing array index 0/1/2 = more Left / more Posterior / more Superior. We
resample to isotropic spacing and use array_index * spacing_mm directly as a physical
coordinate (origin/absolute position is arbitrary but internally consistent — all
derived metrics are relative lengths/diameters, so this is sufficient).

See compare_loss_viz.py / qualitative_assessment.py for related earlier mask utilities.
"""

import csv
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import networkx as nx
import nibabel as nib
import numpy as np
from scipy import ndimage
from scipy.interpolate import splprep, splev
from scipy.spatial import ConvexHull, cKDTree
from skimage.morphology import skeletonize

TARGET_SPACING = 0.6          # mm, isotropic resample target
SPUR_PRUNE_MM = 5.0           # prune skeleton leaf branches shorter than this
CARINA_CHILD_MIN_MM = 10.0    # each carina child branch must be at least this long
CARINA_BALANCE_MIN = 0.2      # min(child1,child2)/max(child1,child2) must be >= this
CUT_OFFSET_MM = 5.0           # cut plane this far above (root-side of) the carina node
CROSS_SECTION_STEP_MM = 1.0
PATCH_RADIUS_MM = 25.0
PATCH_GRID_SPACING_MM = 0.3

CONNECTIVITY_26 = np.ones((3, 3, 3), dtype=np.uint8)


def load_and_resample(path):
    img = nib.load(str(path))
    arr = (np.asanyarray(img.dataobj) > 0).astype(np.uint8)
    spacing = np.array(img.header.get_zooms()[:3], dtype=np.float64)
    zoom_factors = spacing / TARGET_SPACING
    resampled = ndimage.zoom(arr.astype(np.float32), zoom_factors, order=1)
    resampled = (resampled > 0.5).astype(np.uint8)
    return resampled


def largest_component(mask):
    labeled, n = ndimage.label(mask, structure=CONNECTIVITY_26)
    if n == 0:
        raise ValueError("empty mask")
    sizes = ndimage.sum(mask, labeled, range(1, n + 1))
    biggest = np.argmax(sizes) + 1
    return (labeled == biggest).astype(np.uint8)


def build_skeleton_graph(skel_mask):
    """26-connectivity graph over skeleton voxels. Node = (i,j,k) voxel index."""
    coords = np.argwhere(skel_mask)
    coord_set = set(map(tuple, coords))
    G = nx.Graph()
    offsets = [(dx, dy, dz) for dx in (-1, 0, 1) for dy in (-1, 0, 1) for dz in (-1, 0, 1)
               if not (dx == 0 and dy == 0 and dz == 0)]
    for c in coord_set:
        G.add_node(c)
    for c in coord_set:
        for off in offsets:
            n2 = (c[0] + off[0], c[1] + off[1], c[2] + off[2])
            if n2 in coord_set and n2 > c:  # avoid double-adding
                dist = np.sqrt(sum((o * TARGET_SPACING) ** 2 for o in off))
                G.add_edge(c, n2, weight=dist)
    return G


def reduce_to_branch_graph(G):
    """Collapse degree-2 chains into single weighted edges with stored paths."""
    special = [n for n in G.nodes if G.degree[n] != 2]
    B = nx.MultiGraph()
    B.add_nodes_from(special)
    visited_edges = set()
    for s in special:
        for nbr in G.neighbors(s):
            edge_key = frozenset([s, nbr])
            if (s, nbr) in visited_edges:
                continue
            path = [s, nbr]
            length = G[s][nbr]['weight']
            prev, cur = s, nbr
            while G.degree[cur] == 2 and cur not in special:
                nxts = [x for x in G.neighbors(cur) if x != prev]
                if not nxts:
                    break
                nxt = nxts[0]
                length += G[cur][nxt]['weight']
                path.append(nxt)
                prev, cur = cur, nxt
            visited_edges.add((s, nbr))
            visited_edges.add((path[-2], path[-1])) if len(path) >= 2 else None
            # mark both directions of first and last hop as visited where applicable
            if cur in special or cur == s:
                visited_edges.add((cur, path[-2]))
            B.add_edge(s, cur, weight=length, path=path)
    return B


def contract_short_edges(B, threshold=2.0):
    """Collapse micro-branching clusters (edges shorter than `threshold` mm)
    into single nodes, via union-find so every surviving edge keeps its
    ORIGINAL, uncorrupted weight/path (never synthesized through chained
    reassignment, which can silently propagate stale/wrong path data). 3D
    thinning (skeletonize) on blob-like/non-tube regions (e.g. a CT
    field-of-view clipping the trachea tip at a shallow angle) often produces
    a dense tangled mesh of many sub-mm edges rather than a clean 1D curve;
    without this, the carina-search walk just wanders inside that mesh
    instead of following the true single trunk."""
    parent = {n: n for n in B.nodes}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra == rb:
            return
        # keep the higher-z node as representative (helps root tracking)
        if ra[2] >= rb[2]:
            parent[rb] = ra
        else:
            parent[ra] = rb

    for u, v, k, data in B.edges(keys=True, data=True):
        if data['weight'] < threshold:
            union(u, v)

    B2 = nx.MultiGraph()
    for n in B.nodes:
        B2.add_node(find(n))
    for u, v, k, data in B.edges(keys=True, data=True):
        if data['weight'] < threshold:
            continue  # internal to a contracted cluster, drop
        ru, rv = find(u), find(v)
        if ru == rv:
            continue  # both ends collapsed into the same cluster, drop
        B2.add_edge(ru, rv, weight=data['weight'], path=data['path'])
    return B2


def prune_short_spurs(B, min_len=SPUR_PRUNE_MM, protect=frozenset()):
    changed = True
    while changed:
        changed = False
        for n in list(B.nodes):
            if n in protect:
                continue
            if B.degree(n) == 1:
                nbr = next(iter(B[n]))
                edge_data = list(B[n][nbr].values())[0]
                if edge_data['weight'] < min_len and B.degree(nbr) > 1:
                    B.remove_node(n)
                    changed = True
                    break
    return B


def find_root(B):
    # Pick the globally topmost (max-z) node among ALL branch-graph special
    # nodes, BEFORE spur pruning. A CT field-of-view that clips the trachea
    # tip at a shallow angle often skeletonizes that tapering tip into a
    # cluster of several short (<5mm) spurs rather than one clean endpoint;
    # pruning those away would discard the true anatomical top entirely and
    # silently fall back to some unrelated, irrelevant lower branch.
    if not B.nodes:
        raise ValueError("empty branch graph")
    return max(B.nodes, key=lambda n: n[2])


def edge_path_coords(B, a, b):
    data = list(B[a][b].values())[0]
    path = data['path']
    # Orient by proximity, not exact tuple equality: after edge contraction,
    # `a`/`b` may be cluster representatives rather than the original
    # endpoints literally stored at path[0]/path[-1].
    a_phys = np.array(a, dtype=np.float64)
    first_phys = np.array(path[0], dtype=np.float64)
    last_phys = np.array(path[-1], dtype=np.float64)
    if np.linalg.norm(first_phys - a_phys) > np.linalg.norm(last_phys - a_phys):
        path = path[::-1]
    return np.array(path, dtype=np.float64) * TARGET_SPACING, data['weight']


def find_carina(B, root):
    """Dijkstra from root over the branch graph, then evaluate EVERY
    reachable node as a carina candidate (>=2 children each >=10mm, diverging
    left/right) and pick whichever satisfies it with the smallest root
    distance. This avoids the failure mode of a step-by-step greedy walk
    (always taking the single longest child) committing to a wrong turn at
    a minor junction and wandering into a dead-end distal branch without
    ever reaching a real carina."""
    import heapq
    dist = {root: 0.0}
    parent = {root: None}
    visited = set()
    pq = [(0.0, root)]
    order = []
    while pq:
        d, u = heapq.heappop(pq)
        if u in visited:
            continue
        visited.add(u)
        order.append(u)
        for v in B[u]:
            if v in visited:
                continue
            _, length = edge_path_coords(B, u, v)
            nd = d + length
            if v not in dist or nd < dist[v]:
                dist[v] = nd
                parent[v] = u
                heapq.heappush(pq, (nd, v))

    # Effective reach of each node's subtree: the farthest distance reachable
    # by continuing past it (not just the length of its single next edge).
    # A real bifurcation can have a short (<10mm), noisy intermediate segment
    # right at the junction before the true second mainstem bronchus
    # continues further — testing only the immediate edge length would wrongly
    # reject that side. `order` is distance-sorted ascending from the Dijkstra
    # pass, so processing it in reverse does a correct bottom-up accumulation.
    subtree_extent = {n: 0.0 for n in order}
    subtree_deepest = {n: n for n in order}
    for n in reversed(order):
        if n == root:
            continue
        edge_len = dist[n] - dist[parent[n]]
        cand_extent = edge_len + subtree_extent[n]
        if cand_extent > subtree_extent[parent[n]]:
            subtree_extent[parent[n]] = cand_extent
            subtree_deepest[parent[n]] = subtree_deepest[n]

    import os
    debug = os.environ.get("TRACHEA_DEBUG") == "1"
    best = None
    for n in order:
        if n == root:
            continue
        others = [v for v in B[n] if v != parent[n]]
        if len(others) < 2:
            continue
        children = []
        for nb in others:
            _, immediate_length = edge_path_coords(B, n, nb)
            effective_length = immediate_length + subtree_extent[nb]
            children.append((nb, effective_length, subtree_deepest[nb]))
        children.sort(key=lambda x: -x[1])
        (c1, l1, d1), (c2, l2, d2) = children[0], children[1]
        sign1 = np.sign(np.array(d1)[0] - np.array(n)[0])
        sign2 = np.sign(np.array(d2)[0] - np.array(n)[0])
        diverging = sign1 != 0 and sign2 != 0 and sign1 != sign2
        balanced = (l2 / l1) >= CARINA_BALANCE_MIN if l1 > 0 else False
        ok = l1 >= CARINA_CHILD_MIN_MM and l2 >= CARINA_CHILD_MIN_MM and diverging and balanced
        if debug and dist[n] < 250:
            print(f"    [debug] candidate at dist={dist[n]:.1f}mm node={n}: "
                  f"effective children=[{l1:.1f},{l2:.1f}]mm diverging={diverging} -> {'ACCEPT' if ok else 'reject'}",
                  flush=True)
        if ok and (best is None or dist[n] < dist[best]):
            best = n

    if best is None:
        raise ValueError("no carina candidate found anywhere in the reachable branch graph")

    trail = [best]
    while trail[-1] != root:
        trail.append(parent[trail[-1]])
    trail.reverse()
    print(f"  carina candidate: {best} at {dist[best]:.1f}mm from root "
          f"({len(order)} nodes reachable, {sum(1 for _ in order)} evaluated)", flush=True)
    return best, trail


def get_full_path(B, trail):
    """Concatenate branch-graph edge paths along `trail` into one ordered list
    of voxel-index tuples from root to the last trail node (e.g. the carina)."""
    full = [trail[0]]
    for a, b in zip(trail[:-1], trail[1:]):
        # edge_path_coords already orients the path to start near `a`
        # (by proximity, not exact identity — `a`/`b` may be cluster
        # representatives after contraction) — trust that orientation as-is.
        coords_phys, _ = edge_path_coords(B, a, b)
        path_voxels = (coords_phys / TARGET_SPACING).round().astype(np.int64)
        path_voxels = [tuple(p) for p in path_voxels]
        full.extend(path_voxels[1:])
    return full


def arclength(points_phys):
    diffs = np.diff(points_phys, axis=0)
    seglen = np.linalg.norm(diffs, axis=1)
    return np.concatenate([[0.0], np.cumsum(seglen)])


def trim_to_cut_point(path_voxels, cut_offset_mm=CUT_OFFSET_MM):
    phys = np.array(path_voxels, dtype=np.float64) * TARGET_SPACING
    arclen = arclength(phys)
    full_length = arclen[-1]
    target = max(full_length - cut_offset_mm, 0.0)
    idx = np.searchsorted(arclen, target) - 1
    idx = max(idx, 0)
    if idx >= len(phys) - 1:
        cut_point = phys[-1]
        tangent = phys[-1] - phys[-2]
    else:
        t = (target - arclen[idx]) / max(arclen[idx + 1] - arclen[idx], 1e-9)
        cut_point = phys[idx] + t * (phys[idx + 1] - phys[idx])
        tangent = phys[idx + 1] - phys[idx]
    tangent = tangent / max(np.linalg.norm(tangent), 1e-9)
    trimmed_voxels = path_voxels[:idx + 1]
    trimmed_phys = np.vstack([phys[:idx + 1], cut_point])
    return trimmed_voxels, trimmed_phys, cut_point, tangent, full_length


def assign_trachea_mask(mask, G, trachea_voxel_set):
    all_voxel_idx = list(G.nodes)
    all_phys = np.array(all_voxel_idx, dtype=np.float64) * TARGET_SPACING
    labels = np.array([1 if v in trachea_voxel_set else 0 for v in all_voxel_idx])
    tree = cKDTree(all_phys)

    fg_voxel_idx = np.argwhere(mask)
    fg_phys = fg_voxel_idx.astype(np.float64) * TARGET_SPACING
    _, nn_idx = tree.query(fg_phys, k=1)
    nn_label = labels[nn_idx]
    trachea_candidates = fg_voxel_idx[nn_label == 1]
    return trachea_candidates


def apply_cut_plane(candidates_voxel_idx, cut_point, tangent):
    phys = candidates_voxel_idx.astype(np.float64) * TARGET_SPACING
    proj = (phys - cut_point[None, :]) @ tangent
    keep = proj <= 0
    return candidates_voxel_idx[keep]


def fit_centerline_spline(points_phys, smoothing_per_point=0.5):
    from scipy.interpolate import UnivariateSpline
    arclen = arclength(points_phys)
    t = arclen / arclen[-1]
    s = len(points_phys) * smoothing_per_point
    splines = [UnivariateSpline(t, points_phys[:, i], k=3, s=s) for i in range(3)]
    tt = np.linspace(0, 1, 2000)
    fine = np.stack([sp(tt) for sp in splines], axis=1)
    fine_arclen = arclength(fine)
    return splines, tt, fine_arclen, fine_arclen[-1]


def sample_uniform(splines, tt, fine_arclen, total_len, step=CROSS_SECTION_STEP_MM):
    n = int(total_len // step) + 1
    target_arclens = np.arange(n) * step
    target_arclens = target_arclens[target_arclens <= total_len]
    t_at_target = np.interp(target_arclens, fine_arclen, tt)
    points = np.stack([sp(t_at_target) for sp in splines], axis=1)
    derivs = np.stack([sp.derivative()(t_at_target) for sp in splines], axis=1)
    norms = np.linalg.norm(derivs, axis=1, keepdims=True)
    tangents = derivs / np.clip(norms, 1e-9, None)
    return points, tangents, target_arclens


def cross_section_metrics(mask_arr, point, tangent):
    L_hat = np.array([1.0, 0.0, 0.0])
    P_hat = np.array([0.0, 1.0, 0.0])
    e1 = L_hat - np.dot(L_hat, tangent) * tangent
    e1 /= np.linalg.norm(e1)
    e2 = P_hat - np.dot(P_hat, tangent) * tangent
    e2 -= np.dot(e2, e1) * e1
    e2 /= np.linalg.norm(e2)

    n = int(2 * PATCH_RADIUS_MM / PATCH_GRID_SPACING_MM) + 1
    grid = (np.arange(n) - n // 2) * PATCH_GRID_SPACING_MM
    gx, gy = np.meshgrid(grid, grid, indexing="ij")
    sample_phys = point[None, None, :] + gx[..., None] * e1[None, None, :] + gy[..., None] * e2[None, None, :]
    idx = sample_phys / TARGET_SPACING
    coords = [idx[..., 0], idx[..., 1], idx[..., 2]]
    vals = ndimage.map_coordinates(mask_arr.astype(np.float32), coords, order=1, mode="constant", cval=0)
    patch = vals > 0.5

    labeled, nlab = ndimage.label(patch)
    center_label = labeled[n // 2, n // 2]
    if center_label == 0:
        return None
    region = labeled == center_label
    area_mm2 = region.sum() * (PATCH_GRID_SPACING_MM ** 2)

    rows = np.where(region[:, n // 2])[0]
    transverse_mm = (rows.max() - rows.min() + 1) * PATCH_GRID_SPACING_MM if len(rows) > 0 else np.nan
    cols = np.where(region[n // 2, :])[0]
    ap_mm = (cols.max() - cols.min() + 1) * PATCH_GRID_SPACING_MM if len(cols) > 0 else np.nan

    ys, xs = np.where(region)
    pts = np.stack([ys, xs], axis=1).astype(np.float64) * PATCH_GRID_SPACING_MM
    feret_max = feret_min = np.nan
    if len(pts) >= 3:
        try:
            hull = ConvexHull(pts)
            hull_pts = pts[hull.vertices]
            from scipy.spatial.distance import pdist
            dmat = pdist(hull_pts)
            feret_max = dmat.max() if len(dmat) > 0 else np.nan
            m = len(hull_pts)
            fmin = np.inf
            for i in range(m):
                p1, p2 = hull_pts[i], hull_pts[(i + 1) % m]
                edge = p2 - p1
                elen = np.linalg.norm(edge)
                if elen < 1e-9:
                    continue
                normal = np.array([-edge[1], edge[0]]) / elen
                proj = hull_pts @ normal
                fmin = min(fmin, proj.max() - proj.min())
            feret_min = fmin if np.isfinite(fmin) else np.nan
        except Exception:
            pass

    return dict(area_mm2=area_mm2, transverse_mm=transverse_mm, ap_mm=ap_mm,
                feret_max_mm=feret_max, feret_min_mm=feret_min)


def derive_summary(rows, full_length, root_to_carina_straight):
    import pandas as pd
    df = pd.DataFrame(rows)
    df["tracheal_index"] = df["transverse_mm"] / df["ap_mm"]
    df["saber_sheath"] = df["tracheal_index"] <= 0.67
    df["dist_above_carina_mm"] = full_length - df["arclen_from_root_mm"]

    def value_at(dist_mm):
        sub = df.iloc[(df["dist_above_carina_mm"] - dist_mm).abs().argsort()[:1]]
        if len(sub) == 0 or abs(sub["dist_above_carina_mm"].values[0] - dist_mm) > CROSS_SECTION_STEP_MM * 2:
            return {}
        r = sub.iloc[0]
        return {"area_mm2": r["area_mm2"], "transverse_mm": r["transverse_mm"],
                "ap_mm": r["ap_mm"], "tracheal_index": r["tracheal_index"]}

    summary = dict(
        mean_area_mm2=df["area_mm2"].mean(),
        min_area_mm2=df["area_mm2"].min(),
        mean_tracheal_index=df["tracheal_index"].mean(),
        any_saber_sheath=bool(df["saber_sheath"].any()),
        centerline_length_root_to_carina_mm=full_length,
        straight_distance_root_to_carina_mm=root_to_carina_straight,
        tortuosity=full_length / max(root_to_carina_straight, 1e-9),
        n_cross_sections=len(df),
    )
    for tag, d in [("1cm_above_carina", 10.0), ("2cm_above_carina", 20.0)]:
        v = value_at(d)
        for k, val in v.items():
            summary[f"{k}_at_{tag}"] = val
    return summary, df


def save_sanity_png(mask, trachea_mask_arr, root, carina, out_path, case_name):
    mip_axis = lambda vol: np.max(vol, axis=1)
    fig, axes = plt.subplots(1, 2, figsize=(11, 6))
    full_proj = mip_axis(mask) > 0
    trachea_proj = mip_axis(trachea_mask_arr) > 0
    rgb = np.zeros((*full_proj.shape, 3), dtype=np.float32)
    rgb[full_proj & ~trachea_proj] = [0.6, 0.6, 0.6]
    rgb[trachea_proj] = [1, 0, 0]
    axes[0].imshow(np.rot90(rgb))
    axes[0].set_title("Trachea (red) vs rest of airway (gray)")
    axes[0].axis("off")
    axes[1].imshow(np.rot90(rgb))
    axes[1].set_title("Full mask reference")
    axes[1].axis("off")
    fig.suptitle(case_name)
    fig.tight_layout()
    fig.savefig(out_path, dpi=150)
    plt.close(fig)


def main(case_name, label_type):
    base = Path("/storage/homefs/vd24z940/MICCAI2026/intact")
    if label_type == "gt":
        path = base / "nnUNet_raw/Dataset006_ATM_Airways/labelsTr" / case_name
    else:
        path = (base / "nnUNet_results/Dataset006_ATM_Airways/"
                 "nnUNetTrainer__nnUNetPlans__3d_fullres/fold_0/validation" / case_name)

    print(f"[{case_name}/{label_type}] loading + resampling to {TARGET_SPACING}mm iso...", flush=True)
    mask = load_and_resample(path)
    print(f"  resampled shape: {mask.shape}, voxels: {mask.sum()}", flush=True)

    mask = largest_component(mask)
    print(f"  largest component voxels: {mask.sum()}", flush=True)

    print("  skeletonizing...", flush=True)
    skel = skeletonize(mask.astype(bool))
    print(f"  skeleton voxels: {skel.sum()}", flush=True)

    print("  building skeleton graph...", flush=True)
    G = build_skeleton_graph(skel)
    print(f"  graph: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges", flush=True)

    B = reduce_to_branch_graph(G)
    print(f"  branch graph (pre-contract): {B.number_of_nodes()} nodes, {B.number_of_edges()} edges", flush=True)

    B = contract_short_edges(B)
    print(f"  branch graph (post-contract): {B.number_of_nodes()} nodes, {B.number_of_edges()} edges", flush=True)

    root = find_root(B)
    print(f"  root (most cranial node, pre-prune): {root}", flush=True)

    B = prune_short_spurs(B, protect=frozenset([root]))
    print(f"  branch graph (post-prune): {B.number_of_nodes()} nodes, {B.number_of_edges()} edges", flush=True)

    carina, trail = find_carina(B, root)
    print(f"  carina node: {carina}", flush=True)
    print(f"  trail from root to carina: {trail}", flush=True)

    full_path_voxels = get_full_path(B, trail)
    print(f"  full root->carina path: {len(full_path_voxels)} voxels", flush=True)

    trimmed_voxels, trimmed_phys, cut_point, tangent, full_length = trim_to_cut_point(full_path_voxels)
    print(f"  root->carina length: {full_length:.1f}mm, cut point at {CUT_OFFSET_MM}mm above carina, "
          f"trimmed centerline length: {arclength(trimmed_phys)[-1]:.1f}mm", flush=True)

    root_phys = np.array(root, dtype=np.float64) * TARGET_SPACING
    carina_phys = np.array(carina, dtype=np.float64) * TARGET_SPACING
    straight_dist = np.linalg.norm(carina_phys - root_phys)
    print(f"  straight-line root-carina distance: {straight_dist:.1f}mm, "
          f"tortuosity: {full_length / straight_dist:.3f}", flush=True)

    print("  assigning trachea voxels (nearest-skeleton-branch)...", flush=True)
    trachea_voxel_set = set(trimmed_voxels)
    candidates = assign_trachea_mask(mask, G, trachea_voxel_set)
    print(f"  candidates after nearest-branch assignment: {len(candidates)}", flush=True)
    trachea_vox = apply_cut_plane(candidates, cut_point, tangent)
    print(f"  final trachea voxels after cut-plane: {len(trachea_vox)}", flush=True)

    trachea_mask_arr = np.zeros_like(mask)
    if len(trachea_vox) > 0:
        trachea_mask_arr[trachea_vox[:, 0], trachea_vox[:, 1], trachea_vox[:, 2]] = 1

    print("  fitting centerline spline...", flush=True)
    splines, tt, fine_arclen, spline_total_len = fit_centerline_spline(trimmed_phys)
    points, tangents, target_arclens = sample_uniform(splines, tt, fine_arclen, spline_total_len)
    print(f"  {len(points)} cross-sections at {CROSS_SECTION_STEP_MM}mm spacing", flush=True)

    print("  computing cross-section metrics...", flush=True)
    rows = []
    n_failed = 0
    for p, tan, al in zip(points, tangents, target_arclens):
        m = cross_section_metrics(mask, p, tan)
        if m is None:
            n_failed += 1
            continue
        m["arclen_from_root_mm"] = al
        rows.append(m)
    print(f"  cross-sections: {len(rows)} ok, {n_failed} failed (no lumen found)", flush=True)

    summary, df = derive_summary(rows, full_length, straight_dist)
    print("  === SUMMARY ===", flush=True)
    for k, v in summary.items():
        print(f"    {k}: {v}", flush=True)

    out_dir = Path("/storage/homefs/vd24z940/MICCAI2026/intact/eval_results/trachea")
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = f"{case_name.replace('.nii.gz','')}_{label_type}"
    df.to_csv(out_dir / f"{stem}_cross_sections.csv", index=False)
    with open(out_dir / f"{stem}_summary.csv", "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["metric", "value"])
        for k, v in summary.items():
            writer.writerow([k, v])
    save_sanity_png(mask, trachea_mask_arr, root, carina, out_dir / f"{stem}_sanity.png", f"{case_name} ({label_type})")
    print(f"  wrote outputs to {out_dir} (stem={stem})", flush=True)

    return dict(mask=mask, skel=skel, G=G, B=B, root=root, carina=carina, trail=trail,
                summary=summary, df=df)


if __name__ == "__main__":
    case = sys.argv[1] if len(sys.argv) > 1 else "ATM_073.nii.gz"
    label_type = sys.argv[2] if len(sys.argv) > 2 else "gt"
    main(case, label_type)
