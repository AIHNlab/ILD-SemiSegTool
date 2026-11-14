# ILD-SemiSegTool

Code and plug-ins for the paper **"Prompt-Guided Interactive Segmentation of Interstitial Lung Disease in Thoracic CT"**, accepted at the Thoracic Image Analysis (TIA) Workshop, MICCAI 2026.

- 📄 Paper: [arXiv:2608.28453](https://arxiv.org/abs/2608.28453) · [MICCAI 2026 TIA](https://papers.miccai.org/miccai-2026-sat/TIA_022.html)
- 🤗 Model weights: [AIHNLab/ILD-SemiSegTool](https://huggingface.co/AIHNLab/ILD-SemiSegTool)

## Overview

An interactive tool for segmenting interstitial lung disease (ILD) patterns in thoracic CT. An nnU-Net model produces an automatic segmentation, which a fine-tuned MedSAM2 then refines from user prompts (bounding box, point, lasso or scribble). The tool runs as an OHIF viewer connected to a MONAI Label server, with Orthanc as DICOM storage.

## Models

| Model | Task |
|---|---|
| nnU-Net (Lung, ILD, ILD raw) | Automatic lung and ILD segmentation |
| MedSAM2+nnUNet-ILD | Prompt-guided interactive ILD refinement |

## Installation of the tool and usage

Coming soon...

## Intended use

For research use only. Not validated for clinical use.

## Citation

```bibtex
@inproceedings{dedousis2026promptguided,
  title     = {Prompt-Guided Interactive Segmentation of Interstitial Lung Disease in Thoracic CT},
  author    = {Dedousis, Vasilis and Abdur Rahman, Lubnaa and Brigato, Lorenzo and Dack, Ethan and Christe, Andreas and Frank, Christoph and Funke-Chambour, Manuela and Roos, Justus and Huber, Adrian and Ebner, Lukas and Mougiakakou, Stavroula},
  booktitle = {Thoracic Image Analysis (TIA) Workshop, MICCAI 2026},
  year      = {2026},
  url       = {https://papers.miccai.org/miccai-2026-sat/TIA_022.html},
  note      = {arXiv:2608.28453}
}
```

## Contact

AI in Health and Nutrition (AIHN) Lab, ARTORG Center, University of Bern. For questions, please open an [issue](https://github.com/AIHNlab/ILD-SemiSegTool/issues).
