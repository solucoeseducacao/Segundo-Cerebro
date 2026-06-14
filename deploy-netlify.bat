@echo off
chcp 65001 >nul
echo ========================================
echo   DEPLOY NETLIFY — Segundo Cerebro
echo ========================================
echo.
echo   URL final: https://segundo-cerebro-app.netlify.app
echo   Site ID:   8b59e3d9-ca7d-428e-9f04-c1d6946cda91
echo.

:: Verificar Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERRO] Node.js nao encontrado.
    echo Instale em: https://nodejs.org
    pause
    exit /b 1
)

echo [1/2] Fazendo deploy no Netlify (aguarde, pode demorar 1-2 min)...
echo.

npx -y @netlify/mcp@latest --site-id 8b59e3d9-ca7d-428e-9f04-c1d6946cda91 --proxy-path "https://netlify-mcp.netlify.app/proxy/eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..Gu1Q88VssdPThP4D.EREzxS0aevkQtVn5q3-q9N9IyRejJ6lzWWDYLDygyOV_K7JrV265Y43JJ7ABmEGIai8GRU3QaDsHeQPBgkcqnHRjJg-fTJCdxJiJnLsvNqpB5jTSxfX_eNqxdyCmUTY2XiQSra3EreFR4ZLJbJUF8PJtKgli-OWKfaOmedTXKbXSNalFYqoALxT4xzD9gQTMv9YNCry5hekhA_nTkA35sBqaVn0jR_BTxvZq7BgRWJ_FkQXtoCCItTNvH-bykMW821J9aPvrmgfs_zaIr4prHMPdJcB0wdiv1EWr8OKnQPgMR580QfswyzvsKwZ6ueEByfxIpA70ePkS2qQUqqdQXf36K2XbA35bXFrnXwV14WaHFcw7MYOnpUnuL_6zr-F0rp3VM5GZ.3whAKWawucTjJckt-QJA8w"

if %errorlevel% neq 0 (
    echo.
    echo [ERRO] Deploy falhou.
    echo Tente rodar o deploy-firebase.bat como alternativa.
    pause
    exit /b 1
)

echo.
echo ========================================
echo   DEPLOY NETLIFY CONCLUIDO!
echo ========================================
echo.
echo   Frontend publicado em:
echo   https://segundo-cerebro-app.netlify.app
echo.
echo   IMPORTANTE: Firebase Functions (backend IA, pagamentos)
echo   precisam ser deployadas separadamente via deploy.bat
echo   (Firebase Hosting + Cloud Functions).
echo.
pause
