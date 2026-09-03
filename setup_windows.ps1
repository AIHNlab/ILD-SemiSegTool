# One-shot setup for the ILD-OHIF-Tool backend (MONAI Label server) on
# Windows. Companion to start.txt — read that for how to run the servers
# afterwards; this script only installs things.
#
# NOTE: written and adapted from start.txt plus the fixes verified while
# debugging the equivalent setup_linux.sh on an actual Linux box (see that
# script's comments for the "why"). The Python-level bugs it works around
# (numpy/pydicom_seg/numpymaxflow version conflicts) are OS-agnostic — same
# PyPI packages, same bugs — but this .ps1 file itself has NOT been run end
# -to-end on Windows. If a step errors, check start.txt's Troubleshooting
# section and the equivalent step in setup_linux.sh.
#
# Run in PowerShell (not Git Bash — see the note at the top of start.txt).
# Idempotent: safe to re-run. Does NOT touch the OHIF viewer (Node/yarn)
# side — use build_ohif_docker.sh for that (works identically on Windows
# with Docker Desktop, no Node install needed).

$ErrorActionPreference = "Stop"
$RepoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvName = "ild-ohif"

Write-Host "==> [1/5] GPU check"
$nvidiaSmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if (-not $nvidiaSmi) {
    Write-Warning "nvidia-smi not found — no NVIDIA driver detected. The nnU-Net/SAM2 models need a GPU; inference will fail or be very slow without one."
} else {
    & nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader
}

Write-Host "==> [2/5] Orthanc (DICOM server)"
$orthancSvc = Get-Service -Name Orthanc -ErrorAction SilentlyContinue
if ($orthancSvc) {
    if ($orthancSvc.Status -ne "Running") {
        Write-Host "    Orthanc service found but stopped — starting (needs an elevated PowerShell)"
        Start-Service Orthanc
    } else {
        Write-Host "    already running (Windows service)"
    }
} else {
    Write-Warning "No 'Orthanc' Windows service found. Either install Orthanc as a service (see start.txt step 1), or run it via Docker Desktop instead:`n    docker run -d --name orthanc -p 8042:8042 -p 4242:4242 -e DICOM_WEB_PLUGIN_ENABLED=true -e ORTHANC__AUTHENTICATION_ENABLED=false orthancteam/orthanc"
}

Write-Host "==> [3/5] Miniconda"
$condaExe = Get-Command conda -ErrorAction SilentlyContinue
if (-not $condaExe) {
    $installer = "$env:TEMP\miniconda.exe"
    Invoke-WebRequest -Uri "https://repo.anaconda.com/miniconda/Miniconda3-latest-Windows-x86_64.exe" -OutFile $installer
    Start-Process -FilePath $installer -ArgumentList "/InstallationType=JustMe", "/RegisterPython=0", "/S", "/D=$env:USERPROFILE\miniconda3" -Wait
    Remove-Item $installer
    $env:Path = "$env:USERPROFILE\miniconda3;$env:USERPROFILE\miniconda3\Scripts;$env:Path"
    Write-Warning "Miniconda just installed — open a NEW PowerShell window and re-run this script so 'conda' is on PATH."
    exit 0
}
& conda tos accept --override-channels --channel https://repo.anaconda.com/pkgs/main 2>$null
& conda tos accept --override-channels --channel https://repo.anaconda.com/pkgs/r 2>$null

Write-Host "==> [4/5] Conda env '$EnvName' (python 3.10)"
# python 3.10 is required: newer Python breaks monailabel's numpymaxflow dep
# (pins numpy==1.26.0, no wheel past 3.12), so don't "upgrade" this later.
$envExists = (& conda env list) -match "^\s*$EnvName\s"
if (-not $envExists) {
    & conda create -n $EnvName python=3.10 -y
}
& conda activate $EnvName

Write-Host "==> [5/5] Python packages"
& pip install --upgrade pip -q
& pip install torch -q
& pip install monailabel nnunetv2 -q
& pip install -r "$RepoDir\radiology\requirements.txt" -q

# --- Fix 1: numpy pin -------------------------------------------------
# MedSAM2 (just installed above) floors numpy>=2.0.1, which breaks
# monailabel's numpymaxflow — its compiled extension is built against the
# numpy<2 ABI ("numpy.core.multiarray failed to import" at runtime with
# numpy 2.x). Force it back down; MedSAM2 runs fine on 1.26.4 in practice
# despite its stated floor (see radiology/requirements.txt).
& pip install "numpy==1.26.4" --no-deps -q

# --- Fix 2: pydicom_seg vs pydicom 3.x --------------------------------
# pydicom_seg 0.4.1 (unmaintained upstream) still imports
# `pydicom._storage_sopclass_uids`, a module pydicom 3.0 removed — you'll
# otherwise hit this at server startup:
#   ModuleNotFoundError: No module named 'pydicom._storage_sopclass_uids'
# Don't downgrade pydicom to work around it — dicomweb-client and
# pynetdicom (both pulled in by monailabel) require pydicom>=3 and
# genuinely use its newer API, so a downgrade just trades one ImportError
# for another. Patch the two files instead — SegmentationStorage lives at
# pydicom.uid in both the old and new pydicom.
$SitePackages = & python -c "import site; print(site.getsitepackages()[0])"
$PydicomSegDir = Join-Path $SitePackages "pydicom_seg"
foreach ($f in @("reader.py", "segmentation_dataset.py")) {
    $path = Join-Path $PydicomSegDir $f
    (Get-Content $path) -replace `
        'from pydicom\._storage_sopclass_uids import SegmentationStorage', `
        'from pydicom.uid import SegmentationStorage' `
        | Set-Content $path
}

# --- Fix 3: missing "list saved labels" endpoint -----------------------
# Stock monailabel has no HTTP route for "list every saved label for this
# image", which the OHIF Load Segmentation picker needs. See
# radiology/patch_monailabel_datastore.py for details; idempotent, safe to
# re-run after a monailabel upgrade.
& python "$RepoDir\radiology\patch_monailabel_datastore.py"

# --- MedSAM2's missing Hydra configs ----------------------------------
# MedSAM2's pip build doesn't ship its Hydra config yamls (missing
# MANIFEST.in upstream). Copy them in from the source repo.
$Sam2Dir = & python -c "import sam2, os; print(os.path.dirname(sam2.__file__))"
$Sam2ConfigsDir = Join-Path $Sam2Dir "configs"
if (-not (Test-Path (Join-Path $Sam2ConfigsDir "sam2.1_hiera_t512.yaml"))) {
    $tmp = Join-Path $env:TEMP "MedSAM2_$(Get-Random)"
    & git clone --depth 1 -q https://github.com/bowang-lab/MedSAM2.git $tmp
    Copy-Item "$tmp\sam2\configs\*.yaml" $Sam2ConfigsDir
    Remove-Item -Recurse -Force $tmp
}

Write-Host "==> Model weights (from Annotation_Tool_Test_Data)"
$ModelWeightsDir = Join-Path $RepoDir "Annotation_Tool_Test_Data\model_weights"
if (-not (Test-Path $ModelWeightsDir)) {
    Write-Warning "$ModelWeightsDir not found — skipping. Extract Annotation_Tool_Test_Data.zip first, or place weights under radiology\model\ yourself."
} else {
    $ModelDir = Join-Path $RepoDir "radiology\model"
    New-Item -ItemType Directory -Force -Path (Join-Path $ModelDir "sam2") | Out-Null
    # Directory junctions don't need admin/Developer Mode (unlike symlinks).
    $nnunetLink = Join-Path $ModelDir "nnUNet_results"
    if (-not (Test-Path $nnunetLink)) {
        New-Item -ItemType Junction -Path $nnunetLink -Target (Join-Path $ModelWeightsDir "nnUNet_results") | Out-Null
    }
    # A file junction doesn't exist on Windows, and a real symlink needs
    # admin/Developer Mode — just copy the checkpoint instead (a few GB).
    $samCkpt = Join-Path $ModelDir "sam2\checkpoint_ild.pt"
    if (-not (Test-Path $samCkpt)) {
        Copy-Item (Join-Path $ModelWeightsDir "MedSAM2+nnUnet_results\Full Finetune_b4e60\checkpoint_best_val.pt") $samCkpt
    }
}

Write-Host ""
Write-Host "==> Verifying"
& python -c "import torch; print('torch:', torch.__version__, '| CUDA available:', torch.cuda.is_available())"
& python -c "import monailabel.app"
Write-Host "monailabel.app: import ok"

Write-Host ""
Write-Host "Backend setup complete. Start the server with:"
Write-Host "  conda activate $EnvName"
Write-Host "  cd $RepoDir"
Write-Host "  python -m monailabel.main start_server --app radiology --studies http://localhost:8042/dicom-web --conf models nnunet_lung,nnunet_ild,sam2_ild"
Write-Host ""
Write-Host "For the OHIF viewer, run .\build_ohif_docker.sh (Git Bash) or see start.txt step 5/6."
