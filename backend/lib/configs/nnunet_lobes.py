import logging
import os

from monailabel.interfaces.config import TaskConfig
from lib.infers.nnunet import NNUNet

logger = logging.getLogger(__name__)

# Same layout as the Hugging Face release (backend/model/nnUNet_weights/Lobe/:
# plans.json, dataset.json, checkpoint_best.pth).
MODEL_FOLDER = "nnUNet_weights/Lobe"


class NNUNetLobes(TaskConfig):
    def init(self, name, model_dir, conf, planner, **kwargs):
        super().init(name, model_dir, conf, planner, **kwargs)
        # Lung lobes: left upper/lower, right upper/middle/lower (dataset.json).
        # Long names (short form in brackets) - shown as is everywhere in the viewer.
        LUL, LLL, RUL, RML, RLL = (
            "Left upper lobe (LUL)", "Left lower lobe (LLL)", "Right upper lobe (RUL)",
            "Right middle lobe (RML)", "Right lower lobe (RLL)",
        )
        self.labels = {LUL: 1, LLL: 2, RUL: 3, RML: 4, RLL: 5}
        # Match the viewer's colors (GenericAnatomyColors.js).
        self.label_colors = {
            LUL: [160, 160, 0],  # olive
            LLL: [120, 80, 0],  # brown
            RUL: [0, 120, 120],  # dark teal
            RML: [0, 120, 0],  # dark green
            RLL: [120, 40, 80],  # plum
        }
        self.model_folder = os.path.join(model_dir, MODEL_FOLDER)

    def infer(self) -> dict:
        if not os.path.isfile(os.path.join(self.model_folder, "checkpoint_best.pth")):
            logger.warning(f"Lobes model not found in {self.model_folder} - skipping nnunet_lobes")
            return {}
        return {self.name: NNUNet(self.model_folder, labels=self.labels, label_colors=self.label_colors)}

    def trainer(self):
        return None
