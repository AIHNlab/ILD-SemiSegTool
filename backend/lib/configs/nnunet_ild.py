import os
from monailabel.interfaces.config import TaskConfig
from lib.infers.nnunet import NNUNet

class NNUNetILD(TaskConfig):
    def init(self, name, model_dir, conf, planner, **kwargs):
        super().init(name, model_dir, conf, planner, **kwargs)
        self.labels = {
            "healthy": 1, "ggo": 2, "reticulation": 3, "consolidation": 4,
            "honeycombing": 5, "reticulation_ggo": 6, "bronchiectasis": 7,
            "emphysema": 8,
        }
        self.label_colors = {
            "healthy":          [ 76, 175,  80],   # green
            "ggo":              [255, 235,  59],   # yellow
            "reticulation":     [233,  30,  99],   # pink
            "consolidation":    [244,  67,  54],   # red
            "honeycombing":     [255, 152,   0],   # orange
            "reticulation_ggo": [  0, 188, 212],   # cyan
            "bronchiectasis":   [ 33, 150, 243],   # blue
            "emphysema":        [156,  39, 176],   # purple
        }
        self.model_folder = os.path.join(
            model_dir, "nnUNet_results/Dataset003_ILD_raw/nnUNetTrainer__nnUNetPlans__3d_fullres")

    def infer(self) -> dict:
        return {self.name: NNUNet(self.model_folder, labels=self.labels,
                                  label_colors=self.label_colors)}

    def trainer(self):
        return None