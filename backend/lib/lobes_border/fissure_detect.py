"""Step 2 (v2, CIP-style): visible-fissure detection guided by a reference fissure plane.
A voxel is 'visible fissure' if, within BAND mm of the reference plane of fissure k, it is a bright plate
(Hessian: l3<0, |l2|/|l3|<RS_MAX, -l3>CONTRAST) whose plate normal (e3) is within ANG deg of the plane normal.
Reference planes: fissures/<ds>/<ref>/<case>.nii.gz (1=LO 2=RO 3=RH). Output fissures/<ds>/visible_<ref>/<case>.nii.gz (labels 1..3)."""
import sys, os, glob, numpy as np, SimpleITK as sitk
from scipy import ndimage as ndi
from multiprocessing import Pool
B = "/storage/scratch/users/vd24z940/lobe_bench"
ISO, SIGMAS, BAND, RS_MAX, ANG, CONTRAST, MIN_CC_MM2 = 0.7, (0.7, 1.0), 5.0, 0.5, 30.0, float(os.environ.get("CONTRAST", 15)), 10.0

def rs(img, interp, ref=None):
    if ref is not None: return sitk.Resample(img, ref, sitk.Transform(), interp, 0, img.GetPixelID())
    sz = [int(round(a * o / ISO)) for a, o in zip(img.GetSize(), img.GetSpacing())]
    return sitk.Resample(img, sz, sitk.Transform(), interp, img.GetOrigin(), (ISO,)*3, img.GetDirection(), -1024 if img.GetPixelID()==sitk.sitkFloat32 else 0, img.GetPixelID())

def hessian_eig(v, idx, q):
    H = {}
    for (i, j) in [(0,0),(1,1),(2,2),(0,1),(0,2),(1,2)]:
        o = [0,0,0]; o[i] += 1; o[j] += 1; H[(i,j)] = (ndi.gaussian_filter(v, q, order=o) * q * q)[idx]
    M = np.stack([np.stack([H[(0,0)],H[(0,1)],H[(0,2)]],-1), np.stack([H[(0,1)],H[(1,1)],H[(1,2)]],-1),
                  np.stack([H[(0,2)],H[(1,2)],H[(2,2)]],-1)], -2)
    w, V = np.linalg.eigh(M); o = np.argsort(np.abs(w), -1)
    w = np.take_along_axis(w, o, -1); e3 = np.take_along_axis(V, o[:, None, :], -1)[:, :, 2]
    return w, e3

def run(cid, ds, ref):
    out = f"{B}/fissures/{ds}/visible_{ref}/{cid}.nii.gz"
    if os.path.exists(out): return
    if not os.path.exists(f"{B}/fissures/{ds}/{ref}/{cid}.nii.gz"): return
    ct = sitk.ReadImage(f"{B}/data/{ds}/images/{cid}_0000.nii.gz", sitk.sitkFloat32)
    lab = sitk.ReadImage(f"{B}/preds/{ds}/{ref}/{cid}.nii.gz") if ref != "GT" else sitk.ReadImage(f"{B}/data/{ds}/gt/{cid}.nii.gz")
    pl = sitk.ReadImage(f"{B}/fissures/{ds}/{ref}/{cid}.nii.gz")
    cti = rs(ct, sitk.sitkLinear); v = sitk.GetArrayFromImage(cti)
    P = sitk.GetArrayFromImage(rs(pl, sitk.sitkNearestNeighbor)); L = sitk.GetArrayFromImage(rs(lab, sitk.sitkNearestNeighbor))
    bb = np.argwhere(P > 0); lo = np.maximum(bb.min(0) - 15, 0); hi = bb.max(0) + 16; sl = tuple(slice(a, b) for a, b in zip(lo, hi))
    v, P, L = v[sl], P[sl], L[sl]; vc = np.clip(v, -1000, -500); res = np.zeros(v.shape, np.uint8)
    groups = {1: ({1}, {2}), 2: ({3, 4}, {5}), 3: ({3}, {4})}
    for k, (a, b) in groups.items():
        if not (P == k).any(): continue
        d = ndi.distance_transform_edt(P != k) * ISO
        band = (d <= BAND) & np.isin(L, [1, 2, 3, 4, 5]) & (v > -1000) & (v < -300)
        # plane normal = gradient of smoothed indicator(A) - indicator(B)
        ind = np.isin(L, list(a)).astype(np.float32) - np.isin(L, list(b)).astype(np.float32)
        g = np.stack(np.gradient(ndi.gaussian_filter(ind, 3.0 / ISO)), -1)
        idx = np.nonzero(band); n = g[idx]; n /= (np.linalg.norm(n, axis=1, keepdims=True) + 1e-9)
        hit = np.zeros(len(idx[0]), bool)
        for s in SIGMAS:
            w, e3 = hessian_eig(vc, idx, s / ISO)
            l2, l3 = w[:, 1], w[:, 2]
            ok = (l3 < 0) & (np.abs(l2) / (np.abs(l3) + 1e-6) < RS_MAX) & (-l3 > CONTRAST) & \
                 (np.abs((e3 * n).sum(1)) > np.cos(np.deg2rad(ANG)))
            hit |= ok
        m = np.zeros(v.shape, bool); m[idx] = hit
        cc, nc = ndi.label(m, ndi.generate_binary_structure(3, 3))
        if nc:
            sizes = np.bincount(cc.ravel()) * ISO * ISO; keep = sizes >= MIN_CC_MM2; keep[0] = False; m = keep[cc]
        res[m] = k
    full = np.zeros(cti.GetSize()[::-1], np.uint8); full[sl] = res
    fi = sitk.GetImageFromArray(full); fi.CopyInformation(cti)
    fo = rs(fi, sitk.sitkNearestNeighbor, ref=ct)
    os.makedirs(os.path.dirname(out), exist_ok=True); sitk.WriteImage(fo, out); print(cid, ref, "done", flush=True)

if __name__ == "__main__":
    ds, ref = sys.argv[1], sys.argv[2]
    cases = sys.argv[3:] or sorted(os.path.basename(p)[:-7] for p in glob.glob(f"{B}/data/{ds}/gt/*.nii.gz"))
    with Pool(max(1, int(os.environ.get("SLURM_CPUS_PER_TASK", 2)) // 2)) as p: p.starmap(run, [(c, ds, ref) for c in cases])
