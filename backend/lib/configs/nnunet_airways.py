import logging
import os

from monailabel.interfaces.config import TaskConfig
from lib.infers.nnunet import NNUNet

logger = logging.getLogger(__name__)

# Same layout as the Hugging Face release (backend/model/nnUNet_weights/Airways/:
# plans.json, dataset.json, checkpoint_best.pth).
MODEL_FOLDER = "nnUNet_weights/Airways"


class NNUNetAirways(TaskConfig):
    def init(self, name, model_dir, conf, planner, **kwargs):
        super().init(name, model_dir, conf, planner, **kwargs)
        self.labels = {"airway": 1}
        self.label_colors = {"airway": [255, 0, 0]}  # matches the viewer's anatomy colors (GenericAnatomyColors.js)
        self.model_folder = os.path.join(model_dir, MODEL_FOLDER)

    def infer(self) -> dict:
        if not os.path.isfile(os.path.join(self.model_folder, "checkpoint_best.pth")):
            logger.warning(f"Airways model not found in {self.model_folder} - skipping nnunet_airways")
            return {}
        return {self.name: NNUNet(self.model_folder, labels=self.labels, label_colors=self.label_colors)}

    def trainer(self):
        return None
