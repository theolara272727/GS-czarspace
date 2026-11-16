#Rodando o server:
Rode o comando:
```
py -m flask --app flaskr run
```

## Configuração da porta serial

Por padrão, o backend envia os comandos do Terminal pela porta `COM3`, a 9600 baud.
No PowerShell, a porta e o baud rate podem ser configurados antes de iniciar o servidor:

```powershell
$env:SERIAL_PORT = 'COM3'
$env:SERIAL_BAUD = '9600'
py -m flask --app flaskr run
```

Os comandos digitados no widget Terminal são enviados em UTF-8 e recebem `\n` ao final.

## Formato da telemetria recebida

Cada linha da porta serial deve conter a timestamp de coleta, o código hexadecimal do
modo e os valores na mesma ordem dos tipos configurados, separados por espaços:

```text
2026-09-04T14:30:00Z 0x01 1013.25 24.8
```

Espaços múltiplos e tabulações também são aceitos. Como alternativa, também é
possível enviar JSON:

```json
{"timestamp":"2026-09-04T14:30:00Z","modeCode":"0x01","values":[1013.25,24.8]}
```

O código é configurado no menu de cada modo. O backend usa esse código para mapear
os valores, armazena as timestamps de coleta e recebimento e envia ao navegador a
telemetria já nomeada.

O histórico de telemetria é salvo em `instance/historico_voo.csv`. Na primeira
execução desta versão, os dados de um eventual `instance/historico_voo.db` antigo
são copiados automaticamente para o CSV.

## Constelação UWB e manobras (Missão 2)

A GS lê a GS UWB (`UWB_GS.ino`), mostra a constelação em 3D e decide as manobras de
Beatriz e Carolina com `flaskr/analisar_manobras.py` (cópia sem alterações). A lógica do
antigo `gs_manobras.py` está em `flaskr/uwb.py`.

IDs das placas: `0` = GS, `1` = Beatriz, `2` = Gabriella (referência), `3` = Carolina.

| Fonte | Como rodar |
|---|---|
| Simulada (padrão, sem hardware) | `py -m flask --app flaskr run` |
| GS real pela serial | `$env:GS_UWB = 'serial'; $env:SERIAL_PORT = 'COM45'; py -m flask --app flaskr run` |
| Desligada (telemetria antiga) | `$env:GS_UWB = 'off'; py -m flask --app flaskr run` |

No modo `serial` a GS usa 115200 baud e liga sozinha o modo CSV (comando `V`). Feche o
Serial Monitor do Arduino IDE antes: a porta só pode estar aberta em um programa por vez.
Os comandos `P`, `R`, `V`, `D<val>` podem ser enviados pelo widget Terminal, que também
mostra o que a GS imprime.

Na primeira execução é criado o modo `0x10 · Constelação UWB`, com os widgets
**Constelação 3D** e **Manobras** (também disponíveis em ADD PANEL). A cada 5 s as
manobras são reavaliadas; o botão FORÇAR calcula as 3 estratégias mesmo se nominal.

Escala, altitude, janela da média móvel etc. ficam no topo de `flaskr/uwb.py`.

Arquivos gerados em `instance/`:
- `historico_voo.csv`: distâncias médias (`dA1..d23` em m, `dBG_km`, `dGC_km`), para REPLAY.
- `uwb_bruto.csv`: linhas `D,a,b,dist,rx,t` recebidas (só no modo serial).
- `manobras.jsonl`: cada manobra nova calculada.
