#Rodando o server:
Rode o comando:
```
py -m flask --app flaskr run
```

## Configuração da porta serial

Existem dois canais independentes: **Principal** (telemetria normal) e **DW1000**
(constelação e manobras). Cada um tem sua conexão, trava de acesso e reconexão.
A porta principal usa `COM14` e o DW1000 usa `COM15`, ambas a 115200 baud por padrão.
A simulação UWB está desativada, inclusive com `GS_UWB=simulado`.

No PowerShell, configure as duas portas antes de iniciar o servidor (substitua as COMs):

```powershell
$env:SERIAL_PORT = 'COM14'
$env:SERIAL_BAUD = '115200'
$env:UWB_SERIAL_PORT = 'COM15'
$env:UWB_SERIAL_BAUD = '115200'
$env:GS_UWB = 'serial'
py -m flask --app flaskr run
```

Os comandos digitados no widget Terminal são enviados em UTF-8 e recebem `\n` ao final.
O seletor **Principal / DW1000 / Ambas** escolhe o destino de envio e filtra a recepção
no terminal. **Principal** exibe só a porta principal, **DW1000** só a segunda porta,
e **Ambas** mostra as duas. A troca também filtra as linhas já recebidas, sem apagá-las.
A seleção
do terminal é salva com o layout do modo. O terminal identifica a origem com o canal
e a porta física; as linhas recebidas da porta UWB aparecem quando o seletor está
em **DW1000** ou **Ambas**, inclusive medidas e respostas de comandos, independentemente
do modo de telemetria selecionado. Medidas reconhecidas aparecem com os nomes dos
campos separados por `|`; mensagens fora do protocolo aparecem como texto bruto.
Valores indisponíveis (`nan`) são exibidos como `—`, sem duplicar a linha em formato bruto.

Na aba **CMD**, cada botão tem um destino próprio, que pode ser alterado no seletor
ao lado do botão. Novos comandos também permitem escolher o destino. Ele é salvo
como `target` (`main`, `uwb` ou `both`) em `instance/commands.json`; comandos antigos sem
esse campo continuam usando a porta principal. `{timestamp}` continua sendo
substituído pelo Unix atual em segundos no momento do envio. **Ambas** tenta o envio
uma vez em cada porta, mesmo que uma delas falhe, e informa o resultado de cada uma.
O comando enviado e seu retorno (confirmação ou erro) aparecem no widget Terminal,
não na aba CMD. Se nenhum terminal estiver aberto, um é criado automaticamente.

As duas portas devem ser diferentes. Uma falha na UWB não fecha a conexão principal
e vice-versa. A simulação UWB não impede enviar comandos para a porta principal;
envios para UWB são recusados quando ela está desligada ou em simulação.

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
| Desligada | `$env:GS_UWB = 'off'` |
| GS UWB real, simultânea à serial principal | `$env:GS_UWB = 'serial'` e `$env:UWB_SERIAL_PORT = 'COM15'` |
| Simulação desativada (equivale a UWB desligada) | `$env:GS_UWB = 'simulado'` |

Depois execute `py -m flask --app flaskr run`. Se `GS_UWB` não estiver definido,
a fonte UWB serial é ativada usando `COM15` ou a porta definida em `UWB_SERIAL_PORT`.

No modo `serial` a GS UWB usa seu próprio baud rate (`UWB_SERIAL_BAUD`, padrão
115200). Ambas as portas usam o mesmo parser (`flaskr/telemetry.py`): o código
recebido seleciona o modo de `instance/config.json` e a ordem de `dataTypes` nomeia
os valores. Não existe uma ordem alternativa fixa para mensagens DW1000.

Por exemplo, se `dataTypes` do modo `0x31` estiver definido como
`Origem, D_GS, D_Gabriella, D_Carolina, D_Beatriz`, a linha correspondente é:

```text
timestamp 0x31 Origem D_GS D_Gabriella D_Carolina D_Beatriz
346 0x31 0 nan 1.543139 nan nan
```

As distâncias estão em metros. O processador consome os campos já nomeados
(`Origem`, `D_GS`, `D_Gabriella`, `D_Carolina`, `D_Beatriz`), independentemente de suas
posições no pacote. Mudar a ordem na configuração muda o parsing a partir das
próximas mensagens; o firmware deve transmitir na mesma ordem. O modo deve estar
cadastrado e a quantidade de valores deve coincidir com `dataTypes`; caso contrário,
a mensagem fica como texto bruto no terminal, assim como na porta principal.

`Origem` usa os IDs acima; cada distância válida
atualiza o par origem/destino correspondente. `nan`, infinitos e distâncias negativas
não substituem medidas válidas, e a distância de um nó para si mesmo é ignorada.
A idade das medidas usa o horário de recebimento, pois a timestamp da placa pode ser
o tempo desde que ligou (não necessariamente Unix).

O CSV legado `D,a,b,dist_m,rx_dBm,t_ms` continua aceito por um adaptador específico,
pois esse protocolo não contém código de modo. O comando `V` não é mais
enviado automaticamente por padrão (`UWB_AUTO_ENABLE_CSV=False`). Feche o
Serial Monitor do Arduino IDE antes: a porta só pode estar aberta em um programa por vez.
Os comandos `P`, `R`, `V`, `D<val>` podem ser enviados pelo widget Terminal, que também
mostra o que a GS imprime.

Nenhum modo é criado automaticamente. Adicione **Constelação 3D** e **Manobras**
usando ADD PANEL no modo desejado. A constelação recebe o evento `uwb_data`, separado
do `new_data` da porta principal, sem depender do código de modo. Assim, medidas UWB
não substituem a telemetria CARGA `0x10` nem alimentam gráficos/bateria por engano.
A cada 5 s as
manobras são reavaliadas; o botão FORÇAR calcula as 3 estratégias mesmo se nominal.

Escala, altitude, janela da média móvel etc. ficam no topo de `flaskr/uwb.py`.

Arquivos gerados em `instance/`:
- `historico_voo.csv`: telemetria da porta principal.
- `historico_uwb.csv`: arquivo separado com distâncias médias (`dA1..d23` em m,
  `dBG_km`, `dGC_km`); não é misturado ao histórico principal.
- `uwb_bruto.csv`: linhas `D,a,b,dist,rx,t` recebidas (só no modo serial).
- `manobras.jsonl`: cada manobra nova calculada.

O REPLAY consulta `historico_voo.csv` e `historico_uwb.csv`, filtrando pelo código
do modo e ordenando as amostras por horário. A origem de cada amostra é preservada,
sem juntar medidas de canais diferentes. O histórico UWB continua disponível com
a recepção desligada; antes da primeira gravação, a ausência desse CSV é normal.
Para o modo `0x31`, são reproduzidas as distâncias médias já armazenadas, inclusive
no painel Constelação 3D, não os pacotes brutos nem o log de decisões de manobra.

### Repasse da missão 3

O painel **Repasse M3**, disponível em ADD PANEL, recebe os avisos `0x32` com
`De`, `Para`, `Visitados`, `ICAO` e `Sequencia`. Mostra uma rede 2D com setas
direcionais, destaca o último salto e lista os avisos da mensagem selecionada.
O seletor acompanha a última mensagem ou fixa uma combinação ICAO/sequência.
O painel mantém até 200 avisos e pode reproduzir as amostras do REPLAY; ao iniciar
outra reprodução ou retornar ao LIVE, o estado anterior é limpo.

Os nós são identificados pelos IDs recebidos. `Visitados` é mostrado como valor
bruto, sem assumir uma codificação de máscara. A correlação ICAO/sequência não
garante unicidade entre sessões. As setas representam avisos de repasse, não
confirmações de entrega; eventos `0xF4` não são usados nesta primeira versão.

Testes sem hardware:

```powershell
.\.venv\Scripts\python.exe -B -m unittest discover -s tests -p "test_*.py"
node tests/serial_ui.test.cjs
node tests/map_widget.test.cjs
```
