import json
import logging
import os
import shutil

from monailabel.interfaces.config import TaskConfig
from lib.infers.nnunet import NNUNet

logger = logging.getLogger(__name__)

# The airways model is distributed as a single nnU-Net checkpoint
# (model_weights/nnUNet_results/Dataset005_Airways/airways.pth) rather than
# the usual nnUNet_results folder - but the checkpoint embeds everything that
# folder holds (plans, dataset.json, configuration, fold), so it's rebuilt
# next to it on first start. The checkpoint itself is linked, not copied.
CHECKPOINT = "nnUNet_results/Dataset005_Airways/airways.pth"


def _load_checkpoint_metadata(path):
    """init_args + trainer_name from an nnU-Net checkpoint, via torch's
    weights_only loader - the only extra types it needs are numpy
    scalars/dtypes (saved under numpy 2's `numpy._core` name)."""
    import _codecs

    import numpy as np
    import torch

    try:
        from numpy._core.multiarray import scalar
    except ImportError:  # numpy < 2
        from numpy.core.multiarray import scalar

    safe = [(scalar, "numpy._core.multiarray.scalar"), np.dtype, _codecs.encode]
    safe += [getattr(np.dtypes, n) for n in dir(np.dtypes) if n.endswith("DType")]
    with torch.serialization.safe_globals(safe):
        ckpt = torch.load(path, map_location="cpu", weights_only=True)
    return ckpt["init_args"], ckpt["trainer_name"]


def _ensure_model_folder(checkpoint_path):
    """Returns the nnU-Net trained-model folder for checkpoint_path, creating
    <trainer>__<plans>__<configuration>/{plans.json, dataset.json,
    fold_<n>/checkpoint_final.pth} beside it if it doesn't exist yet."""
    root = os.path.dirname(checkpoint_path)
    for entry in sorted(os.listdir(root)):
        folder = os.path.join(root, entry)
        if "__" in entry and os.path.isfile(os.path.join(folder, "plans.json")):
            return folder

    init_args, trainer_name = _load_checkpoint_metadata(checkpoint_path)
    plans = init_args["plans"]
    folder = os.path.join(root, f"{trainer_name}__{plans['plans_name']}__{init_args['configuration']}")
    fold_dir = os.path.join(folder, f"fold_{init_args['fold']}")
    os.makedirs(fold_dir, exist_ok=True)
    with open(os.path.join(folder, "plans.json"), "w") as f:
        json.dump(plans, f, indent=2)
    with open(os.path.join(folder, "dataset.json"), "w") as f:
        json.dump(init_args["dataset_json"], f, indent=2)

    target = os.path.join(fold_dir, "checkpoint_final.pth")
    if not os.path.exists(target):
        try:
            os.symlink(os.path.relpath(checkpoint_path, fold_dir), target)
        except OSError:  # e.g. Windows without symlink rights
            try:
                os.link(checkpoint_path, target)
            except OSError:
                shutil.copyfile(checkpoint_path, target)
    logger.info(f"Built nnU-Net model folder for {checkpoint_path}: {folder}")
    return folder


class NNUNetAirways(TaskConfig):
    def init(self, name, model_dir, conf, planner, **kwargs):
        super().init(name, model_dir, conf, planner, **kwargs)
        self.labels = {"airway": 1}
        self.label_colors = {"airway": [255, 0, 0]}  # matches the viewer's anatomy colors (GenericAnatomyColors.js)
        self.checkpoint_path = os.path.join(model_dir, CHECKPOINT)

    def infer(self) -> dict:
        if not os.path.exists(self.checkpoint_path):
            logger.warning(f"Airways model not found at {self.checkpoint_path} - skipping nnunet_airways")
            return {}
        model_folder = _ensure_model_folder(self.checkpoint_path)
        return {self.name: NNUNet(model_folder, labels=self.labels, label_colors=self.label_colors)}

    def trainer(self):
        return None
