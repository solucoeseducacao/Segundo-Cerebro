@echo off
cd /d "%~dp0"
echo ================================================
echo   Deploy Segundo Cerebro - Hosting + Firestore
echo ================================================
echo.
echo [1/2] Publicando Firestore Rules...
firebase deploy --only firestore:rules
echo.
echo [2/2] Publicando Frontend (Hosting)...
firebase deploy --only hosting
echo.
echo ================================================
echo   Deploy concluido!
echo ================================================
echo.
echo Proximo passo: fazer Manual Deploy no Render
echo para aplicar as mudancas do server.js
echo.
pause
