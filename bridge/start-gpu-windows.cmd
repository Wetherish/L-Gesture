@echo off
setlocal
cd /d "%~dp0"
echo Roofcat GPU setup - keep this window open while using SAM 2.1.
echo First setup downloads the CUDA runtime and all three models.
for %%P in (3.12 3.11 3.13) do (
    py -%%P -c "import sys; assert sys.maxsize > 2**32" >nul 2>nul
    if not errorlevel 1 (
        py -%%P "%~dp0setup_gpu.py" %*
        if errorlevel 1 goto failed
        exit /b 0
    )
)
python -c "import sys; assert (3,11) <= sys.version_info[:2] <= (3,13); assert sys.maxsize > 2**32" >nul 2>nul
if not errorlevel 1 (
    python "%~dp0setup_gpu.py" %*
    if errorlevel 1 goto failed
    exit /b 0
)
echo Install 64-bit Python 3.11, 3.12 or 3.13 from https://www.python.org/downloads/windows/
echo Enable the Python launcher during installation, then open this file again.
pause
exit /b 1

:failed
echo The GPU setup or service stopped with an error. Read the message above, then rerun this launcher.
pause
exit /b 1
