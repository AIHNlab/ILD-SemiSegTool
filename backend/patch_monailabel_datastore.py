"""Patch the installed monailabel package to add endpoints this app's OHIF
extension needs that stock monailabel doesn't provide:

1. GET /datastore/label/list?image=<id> - the "Load Segmentation" picker
   (plugins/ohifv3/extensions/monai-label, MonaiLabelClient.list_labels)
   needs a JSON array of {"tag": ..., "info": {...}} for an image. Stock
   monailabel only has a tag->label_id mapping
   (Datastore.get_labels_by_image_id) with no HTTP endpoint exposing it,
   plus a separate per-(label,tag) info lookup (GET /datastore/label/info).
   This combines the two.

2. GET /datastore/label/regional_stats?image=<id> - the "Regional Stats"
   tab needs 12-region (2 sides x 3 zones x 2 depths) volumetric ILD
   statistics for an image, computed from its saved lung + ILD masks. The
   actual computation lives in lib/regional_stats.py (in this repo, so
   it's reviewable/testable); this just wires up the thin HTTP route.

3. PUT /datastore/image/preprocess?image=<id> - the "Preprocessing" tab's
   "Preprocess Volume" button resamples the image to 1mm isotropic spacing
   and crops it to the body bounding box, in place, using the functions in
   preprocessing/preprocess_test_ct.py (also in this repo). The actual
   logic lives in lib/preprocess.py; this wires up the HTTP route.

Each patch lives outside site-packages (there's no vendored monailabel
fork), so it's applied here instead - idempotent, safe to re-run,
including after a monailabel upgrade that overwrites previously-applied
patches (each patch detects its own marker already present and no-ops).
Run via setup_linux.sh / setup_mac.sh / setup_windows.ps1, or by hand after
any `pip install --upgrade monailabel`.
"""

import sys

import monailabel.endpoints.datastore as ds_module

TARGET = ds_module.__file__

FUNCTION_ANCHOR = """def remove_label(id: str, tag: str, user: Optional[str] = None):
    logger.info(f"Removing Label: {id} by {user}")
    instance: MONAILabelApp = app_instance()
    instance.datastore().remove_label(id, tag)
    return {}
"""

ROUTE_ANCHOR = '@router.head("/label", summary=f"{RBAC_USER}Check If Label Exists")'

PATCHES = [
    {
        "marker": "/label/list",
        "function_insertion": FUNCTION_ANCHOR
        + """

def list_labels(image: str) -> List[Dict[str, Any]]:
    instance: MONAILabelApp = app_instance()
    d: Datastore = instance.datastore()
    label_ids = d.get_labels_by_image_id(image)
    return [{"tag": tag, "info": d.get_label_info(label_id, tag)} for tag, label_id in label_ids.items()]
""",
        "route_insertion": f"""@router.get("/label/list", summary=f"{{RBAC_USER}}List Saved Labels for an Image")
async def api_list_labels(image: str, user: User = Depends(RBAC(settings.MONAI_LABEL_AUTH_ROLE_USER))):
    return list_labels(image)


{ROUTE_ANCHOR}""",
    },
    {
        "marker": "/label/regional_stats",
        "function_insertion": FUNCTION_ANCHOR
        + """

def regional_stats(image: str, peripheral_distance_mm: float = 20.0) -> Dict[str, Any]:
    instance: MONAILabelApp = app_instance()
    from lib.regional_stats import compute_regional_stats

    return compute_regional_stats(instance, image, peripheral_distance_mm)
""",
        "route_insertion": f"""@router.get(
    "/label/regional_stats", summary=f"{{RBAC_USER}}Compute 12-region ILD volumetric statistics"
)
async def api_regional_stats(
    image: str,
    peripheral_distance_mm: float = 20.0,
    user: User = Depends(RBAC(settings.MONAI_LABEL_AUTH_ROLE_USER)),
):
    try:
        return regional_stats(image, peripheral_distance_mm)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


{ROUTE_ANCHOR}""",
    },
    {
        "marker": "/image/preprocess",
        "function_insertion": FUNCTION_ANCHOR
        + """

def preprocess_image(image: str) -> Dict[str, Any]:
    instance: MONAILabelApp = app_instance()
    from lib.preprocess import preprocess_image as run_preprocess

    return run_preprocess(instance, image)
""",
        "route_insertion": f"""@router.put(
    "/image/preprocess", summary=f"{{RBAC_ANNOTATOR}}Preprocess Image (resample + crop to body bbox)"
)
async def api_preprocess_image(
    image: str,
    user: User = Depends(RBAC(settings.MONAI_LABEL_AUTH_ROLE_ANNOTATOR)),
):
    try:
        return preprocess_image(image)
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e))


{ROUTE_ANCHOR}""",
    },
]


def main() -> int:
    content = open(TARGET, encoding="utf-8").read()
    changed = False

    for patch in PATCHES:
        if patch["marker"] in content:
            print(f"already patched ({patch['marker']}): {TARGET}")
            continue

        if FUNCTION_ANCHOR not in content or ROUTE_ANCHOR not in content:
            print(
                f"ERROR: expected anchors not found in {TARGET} for patch '{patch['marker']}' — "
                "the installed monailabel version's endpoints/datastore.py has likely changed. "
                "Patch it by hand (see this script's docstring for what's needed).",
                file=sys.stderr,
            )
            return 1

        content = content.replace(FUNCTION_ANCHOR, patch["function_insertion"], 1)
        content = content.replace(ROUTE_ANCHOR, patch["route_insertion"], 1)
        changed = True
        print(f"patched ({patch['marker']}): {TARGET}")

    if changed:
        with open(TARGET, "w", encoding="utf-8") as f:
            f.write(content)

    return 0


if __name__ == "__main__":
    sys.exit(main())
