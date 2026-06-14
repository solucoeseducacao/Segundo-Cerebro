@echo off
cd /d "%~dp0"
echo Fazendo deploy do Segundo Cerebro v4...
firebase deploy --only hosting
echo.
echo Deploy concluido! Pressione qualquer tecla para fechar.
pause
