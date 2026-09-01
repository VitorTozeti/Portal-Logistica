@echo off
REM ===========================================================================
REM  run_coletor.bat  --  executa UM ciclo do coletor on-prem do Portal da
REM  Logistica e sai. Feito para o Agendador de Tarefas do Windows disparar
REM  de 15 em 15 minutos (NAO deixa processo de pe; cada disparo roda 1 vez).
REM
REM  O que ele faz por disparo:
REM    - entra na pasta do script (funciona de qualquer lugar via %~dp0);
REM    - usa a venv .venv se existir, senao o python do PATH;
REM    - forca modo one-shot (PORTAL_ONESHOT=1);
REM    - o coletor le o .env (PORTAL_AZURE_BASE/USER/SENHA) e da POST no Azure;
REM    - grava a saida num log diario em coletor_log\AAAA-MM-DD.log.
REM
REM  Agendar (uma vez, no servidor, prompt como Admin):
REM    schtasks /Create /TN "Portal Coletor NFs" /TR "\"%~dp0run_coletor.bat\"" ^
REM             /SC MINUTE /MO 15 /RU SYSTEM /F
REM  (ou pela GUI: Agendador de Tarefas -> Criar Tarefa -> Disparador
REM   "Repetir a cada 15 minutos" -> Acao "Iniciar programa" = este .bat.)
REM ===========================================================================

setlocal
cd /d "%~dp0"

REM --- modo one-shot: 1 ciclo e sai ---
set "PORTAL_ONESHOT=1"

REM --- escolhe o interpretador: venv local, senao python do PATH ---
set "PY=python"
if exist "%~dp0.venv\Scripts\python.exe" set "PY=%~dp0.venv\Scripts\python.exe"

REM --- pasta de log + nome do arquivo por dia (AAAA-MM-DD) ---
if not exist "%~dp0coletor_log" mkdir "%~dp0coletor_log"
for /f "tokens=1-3 delims=/-. " %%a in ("%date%") do set "HOJE=%%c-%%b-%%a"
set "LOG=%~dp0coletor_log\%HOJE%.log"

echo. >> "%LOG%"
echo ===== %date% %time% ===== >> "%LOG%"
"%PY%" "%~dp0coletor_azure.py" --once >> "%LOG%" 2>&1
echo (saida: %ERRORLEVEL%) >> "%LOG%"

endlocal
