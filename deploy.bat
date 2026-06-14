@echo off
chcp 65001 >nul
echo ========================================
echo   DEPLOY — Segundo Cerebro
echo ========================================
echo.

:: Verificar Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERRO] Node.js nao encontrado.
    echo Instale em: https://nodejs.org
    pause
    exit /b 1
)

:: Instalar firebase-tools se necessario
where firebase >nul 2>&1
if %errorlevel% neq 0 (
    echo [1/4] Instalando Firebase CLI...
    npm install -g firebase-tools
    if %errorlevel% neq 0 (
        echo [ERRO] Falha ao instalar firebase-tools.
        pause
        exit /b 1
    )
) else (
    echo [1/4] Firebase CLI ja instalado. OK
)

:: Login
echo.
echo [2/4] Autenticando com Google...
echo     (sera aberta uma janela do navegador)
firebase login
if %errorlevel% neq 0 (
    echo [ERRO] Falha na autenticacao.
    pause
    exit /b 1
)

:: Instalar dependencias das functions
echo.
echo [3/4] Instalando dependencias das Cloud Functions...
cd "%~dp0functions"
npm install
if %errorlevel% neq 0 (
    echo [ERRO] Falha ao instalar dependencias.
    pause
    exit /b 1
)
cd "%~dp0"

:: Deploy
echo.
echo [4/4] Fazendo deploy no Firebase...
echo     Projeto: segundo-cerebro-bfb66
echo.
firebase deploy --project segundo-cerebro-bfb66
if %errorlevel% neq 0 (
    echo.
    echo [ERRO] Deploy falhou. Verifique as mensagens acima.
    pause
    exit /b 1
)

echo.
echo ========================================
echo   DEPLOY CONCLUIDO COM SUCESSO!
echo ========================================
echo.
echo   App publicado em:
echo   https://segundo-cerebro-bfb66.web.app
echo   https://segundo-cerebro-bfb66.firebaseapp.com
echo.
echo   Admin em:
echo   https://segundo-cerebro-bfb66.web.app/admin
echo.
pause
