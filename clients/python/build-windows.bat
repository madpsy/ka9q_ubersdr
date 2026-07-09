@echo off
setlocal enabledelayedexpansion

:: ======================================================================
:: build-windows.bat - Build radio_client.exe on Windows
:: ======================================================================

set "SCRIPT_DIR=%~dp0"
set "VENV_DIR=%SCRIPT_DIR%.venv"

echo.
echo ======================================================================
echo  Radio Client - Windows Build
echo ======================================================================
echo.

:: ----------------------------------------------------------------------
:: Step 1: Check Python is available
:: ----------------------------------------------------------------------
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found on PATH.
    echo         Install Python from https://www.python.org/downloads/
    echo         Make sure to check "Add Python to PATH" during install.
    pause
    exit /b 1
)

echo [INFO] Using Python:
python --version
echo.

:: ----------------------------------------------------------------------
:: Step 2: Check MSVC C++ compiler is available
:: Try cl.exe directly first (already on PATH via Developer Command Prompt)
:: Otherwise search common Visual Studio Build Tools install locations.
:: ----------------------------------------------------------------------
echo [INFO] Checking for MSVC C++ compiler...

cl.exe >nul 2>&1
if not errorlevel 1 (
    echo [INFO] MSVC compiler already active on PATH.
    goto :compiler_ok
)

:: Search for vcvarsall.bat, preferring vswhere.exe (version-independent)
:: since VS install folders are no longer always named by year (e.g. "18"
:: for VS 2026), then falling back to a hardcoded search of known
:: year-based locations for older/nonstandard setups.
set "VCVARSALL="

for %%W in (
    "%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
    "%ProgramFiles%\Microsoft Visual Studio\Installer\vswhere.exe"
) do (
    if exist %%W (
        set "PATH=%%~dpW;%PATH%"
        for /f "usebackq tokens=*" %%I in (`%%W -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do (
            set "CANDIDATE=%%I\VC\Auxiliary\Build\vcvarsall.bat"
            if exist "!CANDIDATE!" (
                set "VCVARSALL=!CANDIDATE!"
                goto :found_vcvarsall
            )
        )
    )
)

for %%Y in (2022 2019 2017) do (
    for %%E in (Enterprise Professional Community BuildTools) do (
        set "CANDIDATE=C:\Program Files\Microsoft Visual Studio\%%Y\%%E\VC\Auxiliary\Build\vcvarsall.bat"
        if exist "!CANDIDATE!" (
            set "VCVARSALL=!CANDIDATE!"
            goto :found_vcvarsall
        )
        set "CANDIDATE=C:\Program Files (x86)\Microsoft Visual Studio\%%Y\%%E\VC\Auxiliary\Build\vcvarsall.bat"
        if exist "!CANDIDATE!" (
            set "VCVARSALL=!CANDIDATE!"
            goto :found_vcvarsall
        )
    )
)

:found_vcvarsall
if defined VCVARSALL (
    echo [INFO] Found MSVC at: %VCVARSALL%
    echo [INFO] Activating x64 toolchain...
    call "%VCVARSALL%" x64
    if errorlevel 1 (
        echo [ERROR] Failed to activate MSVC toolchain.
        pause
        exit /b 1
    )
    echo [INFO] MSVC compiler activated.
    goto :compiler_ok
)

:: Not found - print helpful message
echo [ERROR] MSVC C++ compiler (cl.exe) not found.
echo.
echo         Install Visual Studio Build Tools from:
echo         https://visualstudio.microsoft.com/visual-cpp-build-tools/
echo.
echo         Select "Desktop development with C++" workload during install.
echo.
echo         Alternatively, run this script from a
echo         "Developer Command Prompt for VS" or
echo         "x64 Native Tools Command Prompt for VS".
pause
exit /b 1

:compiler_ok
echo.

:: ----------------------------------------------------------------------
:: Step 3: Create virtual environment if it doesn't exist
:: ----------------------------------------------------------------------
if not exist "%VENV_DIR%\Scripts\activate.bat" (
    echo [INFO] Creating virtual environment at %VENV_DIR% ...
    python -m venv "%VENV_DIR%"
    if errorlevel 1 (
        echo [ERROR] Failed to create virtual environment.
        pause
        exit /b 1
    )
)

:: ----------------------------------------------------------------------
:: Step 4: Activate the virtual environment
:: ----------------------------------------------------------------------
echo [INFO] Activating virtual environment...
call "%VENV_DIR%\Scripts\activate.bat"
if errorlevel 1 (
    echo [ERROR] Failed to activate virtual environment.
    pause
    exit /b 1
)

:: ----------------------------------------------------------------------
:: Step 5: Upgrade pip and install dependencies
:: ----------------------------------------------------------------------
echo [INFO] Upgrading pip...
python -m pip install --upgrade pip

echo [INFO] Installing dependencies from requirements.txt...
pip install -r "%SCRIPT_DIR%requirements.txt"
if errorlevel 1 (
    echo [ERROR] Failed to install dependencies.
    pause
    exit /b 1
)

:: ----------------------------------------------------------------------
:: Step 6: Run the build script
:: ----------------------------------------------------------------------
echo.
echo [INFO] Running build-windows.py...
echo.
python "%SCRIPT_DIR%build-windows.py"
if errorlevel 1 (
    echo.
    echo [ERROR] Build failed.
    pause
    exit /b 1
)

echo.
echo ======================================================================
echo  Build complete! Executable is in: %SCRIPT_DIR%dist\
echo ======================================================================
echo.
pause
