# -*- coding: utf-8 -*-
"""
Integração da GS UWB (UWB_GS.ino) com a análise de manobras (analisar_manobras.py).

Portado de gs_manobras.py para rodar dentro do servidor Flask:

  ESP32 da GS --(serial, linhas CSV "D,a,b,dist_m,rx_dBm,t_ms")--> ProcessadorUwb
     -> média móvel por par de placas
     -> distâncias para o widget "Constelação 3D"
     -> metros medidos -> km da missão (escala)
     -> Beatriz e Carolina: (h, d até a Gabriella)
     -> analisar_manobras.decidir()  -> NOMINAL ou CORRIGIR
     -> se CORRIGIR: analisar_manobras.analisar()  (estratégias 1, 2 e 3)

O analisar_manobras.py não é alterado.
"""
import collections
import math
import random
import re
import statistics
import threading
import time
from datetime import datetime, timezone

from . import analisar_manobras as am

# ============================== CONFIGURAÇÃO ==================================
# ID da placa UWB -> satélite.  ID 0 é a própria GS (âncora principal).
ID_SAT = {1: "Beatriz", 2: "Gabriella", 3: "Carolina"}
ID_GS = 0
SATELITES_MANOBRA = ("Beatriz", "Carolina")   # a Gabriella é a referência (não manobra)

# Escala bancada -> missão: km da missão por metro medido no UWB.
# Com 1000, 1,50 m medido = 1500 km (a distância-alvo).
ESCALA_DIST_KM_POR_M = 1000.0
OFFSET_DIST_M = 0.0          # correção de offset residual do UWB [m] (somado antes da escala)

# Origem da altitude (o UWB mede distância, não altitude):
#   "fixa" -> usa ALT_FIXA_KM
#   "gs"   -> h = d(GS, satélite) * ESCALA_ALT_KM_POR_M + OFFSET_ALT_KM
ALT_FONTE = "fixa"
ALT_FIXA_KM = {"Beatriz": 400.0, "Carolina": 400.0}
ESCALA_ALT_KM_POR_M = 400.0  # só para ALT_FONTE = "gs" (ex.: 1,00 m da GS = 400 km)
OFFSET_ALT_KM = 0.0

JANELA = 40                  # amostras na média móvel de cada par (~10 medidas/s por par -> ~4 s)
# Filtro robusto: o DW1000 solta saltos absurdos (até 40 m numa distância de 1,5 m, em
# 5-18 % das leituras). Com FILTRO_ROBUSTO, descarta da janela o que estiver a mais de
# OUTLIER_K desvios robustos (MAD) da mediana, nunca menos que OUTLIER_MIN_M, e faz a
# média do resto. False volta à média simples do gs_manobras original.
FILTRO_ROBUSTO = True
OUTLIER_K = 3.0
OUTLIER_MIN_M = 0.10
IDADE_MAX_S = 30.0           # par sem medida nova há mais tempo que isso = dado VELHO
PERIODO_S = 5.0              # intervalo entre avaliações de manobra [s]
PERIODO_TELEMETRIA_S = 0.5   # intervalo entre envios das distâncias ao navegador [s]
LIMIAR_REANALISE_KM = 5.0    # só recalcula a manobra se h ou d mudar mais que isso
BAUD = 115200

# Modo da GS em que a telemetria UWB é publicada (aba "MISSION MODES").
MODO_CODIGO = "0x10"
MODO_NOME = "Constelação UWB"

CSV_RE = re.compile(r"D,(\d+),(\d+),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+)")

# Pares usados pelo widget 3D. S1 = Gabriella (central), S2 = Beatriz, S3 = Carolina.
#   chave do widget -> (id_a, id_b)
PARES_WIDGET = {
    "dA1": (ID_GS, 2),   # GS - Gabriella
    "dA2": (ID_GS, 1),   # GS - Beatriz
    "dA3": (ID_GS, 3),   # GS - Carolina
    "d12": (1, 2),       # Gabriella - Beatriz
    "d13": (2, 3),       # Gabriella - Carolina
    "d23": (1, 3),       # Beatriz - Carolina
}
TIPOS_DADOS = list(PARES_WIDGET) + ["dBG_km", "dGC_km"]


def _nome_no(i):
    return "GS" if i == ID_GS else ID_SAT.get(i, f"ID {i}")


def _id_de(nome):
    return next(i for i, n in ID_SAT.items() if n == nome)


def _agora_iso():
    return datetime.now(timezone.utc).isoformat()


# ============================== DADOS DOS PARES ===============================
class Pares:
    """Guarda as últimas JANELA medidas de cada par (i<j) com o instante de chegada."""

    def __init__(self):
        self.amostras = collections.defaultdict(lambda: collections.deque(maxlen=JANELA))
        self.ultimo = {}

    def adiciona(self, a, b, d_m, t):
        par = (min(a, b), max(a, b))
        self.amostras[par].append(d_m)
        self.ultimo[par] = t

    def media(self, a, b):
        """(média filtrada, N de amostras usadas). Ver FILTRO_ROBUSTO."""
        q = self.amostras.get((min(a, b), max(a, b)))
        if not q:
            return None, 0
        valores = list(q)
        if FILTRO_ROBUSTO and len(valores) >= 5:
            mediana = statistics.median(valores)
            mad = statistics.median(abs(x - mediana) for x in valores)
            limite = max(OUTLIER_K * 1.4826 * mad, OUTLIER_MIN_M)
            valores = [x for x in valores if abs(x - mediana) <= limite] or [mediana]
        return sum(valores) / len(valores), len(valores)

    def idade(self, a, b, agora):
        t = self.ultimo.get((min(a, b), max(a, b)))
        return None if t is None else agora - t


# ============================== PROCESSADOR ===================================
class ProcessadorUwb:
    """Recebe as linhas da GS, mantém as médias e calcula as manobras.

    Thread-safe: a thread de leitura chama `processa_linha`, e tanto ela quanto os
    handlers do Socket.IO podem chamar `telemetria` e `avaliar`."""

    def __init__(self):
        self._lock = threading.Lock()
        self._lock_avaliacao = threading.Lock()
        self.pares = Pares()
        self.ultima_analise = {}      # nome -> dict(h, d, estrategias, calculadaEm)
        self.ultimo_resultado = None  # payload completo da última avaliação
        self.medidas_desde_avaliacao = 0
        self.medidas_total = 0

    # ---------- entrada ----------
    def processa_linha(self, linha, t=None):
        """Devolve o texto 'D,...' reconhecido, ou None se a linha não for uma medida."""
        m = CSV_RE.search(linha)
        if not m:
            return None
        a, b = int(m.group(1)), int(m.group(2))
        with self._lock:
            self.pares.adiciona(a, b, float(m.group(3)), time.time() if t is None else t)
            self.medidas_desde_avaliacao += 1
            self.medidas_total += 1
        return m.group(0)

    # ---------- telemetria para os widgets ----------
    def telemetria(self):
        """Médias móveis no formato do widget 3D + distâncias da missão em km."""
        valores = {}
        with self._lock:
            for chave, (a, b) in PARES_WIDGET.items():
                d_m, _ = self.pares.media(a, b)
                if d_m is not None:
                    valores[chave] = round(d_m, 4)
        if "d12" in valores:
            valores["dBG_km"] = round((valores["d12"] + OFFSET_DIST_M) * ESCALA_DIST_KM_POR_M, 1)
        if "d13" in valores:
            valores["dGC_km"] = round((valores["d13"] + OFFSET_DIST_M) * ESCALA_DIST_KM_POR_M, 1)
        if not valores:
            return None
        agora = _agora_iso()
        return {
            "timestamp": agora,
            "receivedTimestamp": agora,
            "modeCode": MODO_CODIGO,
            "modeName": MODO_NOME,
            "values": valores,
        }

    def tabela_pares(self, agora=None):
        agora = time.time() if agora is None else agora
        linhas = []
        with self._lock:
            for i in range(4):
                for j in range(i + 1, 4):
                    d_m, n = self.pares.media(i, j)
                    idade = self.pares.idade(i, j, agora)
                    linhas.append({
                        "par": f"{i}-{j}",
                        "nomes": f"{_nome_no(i)} – {_nome_no(j)}",
                        "mediaM": None if d_m is None else round(d_m, 3),
                        "n": n,
                        "idadeS": None if idade is None else round(idade, 1),
                    })
        return linhas

    # ---------- conversão ----------
    def _estado_satelite(self, nome, agora):
        """(h_km, d_km, info) do satélite em relação à Gabriella, como no gs_manobras."""
        i, g = _id_de(nome), _id_de("Gabriella")
        with self._lock:
            d_m, n = self.pares.media(i, g)
            idade = self.pares.idade(i, g, agora)
            h_m, nh = self.pares.media(ID_GS, i)
            idade_h = self.pares.idade(ID_GS, i, agora)

        base = {"nome": nome, "lado": "atrás" if nome == "Beatriz" else "à frente",
                "altFonte": ALT_FONTE}
        if d_m is None:
            return None, {**base, "status": "SEM DADOS",
                          "info": f"sem medida do par {min(i, g)}-{max(i, g)} ({nome}-Gabriella)"}

        d_km = (d_m + OFFSET_DIST_M) * ESCALA_DIST_KM_POR_M
        info = {**base, "dM": round(d_m, 4), "dKm": round(d_km, 1), "n": n,
                "idadeS": round(idade, 1)}
        velho = idade > IDADE_MAX_S

        if ALT_FONTE == "gs":
            if h_m is None:
                return None, {**info, "status": "SEM DADOS",
                              "info": f"sem medida do par {ID_GS}-{i} (GS-{nome}) para a altitude"}
            h_km = h_m * ESCALA_ALT_KM_POR_M + OFFSET_ALT_KM
            info.update(hM=round(h_m, 4), nH=nh, idadeHS=round(idade_h, 1))
            velho = velho or idade_h > IDADE_MAX_S
        else:
            h_km = ALT_FIXA_KM[nome]
        info.update(hKm=round(h_km, 1), velho=velho)
        return (h_km, d_km), info

    # ---------- avaliação ----------
    def avaliar(self, agora=None, forcar=False):
        """Equivalente ao avaliar() do gs_manobras, mas devolve um dict serializável."""
        agora = time.time() if agora is None else agora
        with self._lock_avaliacao:
            with self._lock:
                n_medidas = self.medidas_desde_avaliacao
                self.medidas_desde_avaliacao = 0

            satelites = {}
            for nome in SATELITES_MANOBRA:
                est, info = self._estado_satelite(nome, agora)
                satelites[nome] = info
                if est is None:
                    continue
                h, d = est
                dec = am.decidir(h, d)
                info.update(status=dec["status"], motivos=dec["motivos"])

                if dec["status"] == "NOMINAL" and not forcar:
                    self.ultima_analise.pop(nome, None)
                    info["estrategias"] = None
                    continue

                ant = self.ultima_analise.get(nome)
                if (ant and not forcar
                        and abs(ant["h"] - h) < LIMIAR_REANALISE_KM
                        and abs(ant["d"] - d) < LIMIAR_REANALISE_KM):
                    info.update(estrategias=ant["estrategias"], calculadaEm=ant["calculadaEm"],
                                reaproveitada=True)
                    continue

                res = am.analisar(nome, h, d, verbose=False, forcar=True) or []
                estrategias = [_estrategia_json(r) for r in res]
                calculada_em = _agora_iso()
                self.ultima_analise[nome] = dict(h=h, d=d, estrategias=estrategias,
                                                 calculadaEm=calculada_em)
                info.update(estrategias=estrategias, calculadaEm=calculada_em,
                            reaproveitada=False)

            for info in satelites.values():
                est = info.get("estrategias") or []
                viaveis = [k for k, e in enumerate(est) if e["viavel"]]
                info["melhor"] = min(viaveis, key=lambda k: est[k]["dvTotal"]) if viaveis else None

            resultado = {
                "timestamp": _agora_iso(),
                "forcado": forcar,
                "medidasDesdeUltima": n_medidas,
                "medidasTotal": self.medidas_total,
                "satelites": satelites,
                "pares": self.tabela_pares(agora),
                "config": {
                    "alvoKm": am.D_ALVO,
                    "bandaKm": am.BANDA_REL * am.D_ALVO,
                    "hRefKm": am.H_REF,
                    "tolAltKm": am.TOL_ALT_KM,
                    "escalaKmPorM": ESCALA_DIST_KM_POR_M,
                    "altFonte": ALT_FONTE,
                    "idadeMaxS": IDADE_MAX_S,
                    "periodoS": PERIODO_S,
                    "envelopeKm": list(am.ENVELOPE) if am.ENVELOPE else None,
                },
            }
            self.ultimo_resultado = resultado
            return resultado


def _arred(valor, casas=1):
    return None if valor is None else round(valor, casas)


def _estrategia_json(r):
    """Converte o resultado de analisa_direto/analisa_faseamento em JSON (m/s, min, km)."""
    out = {"nome": r["nome"], "viavel": bool(r["viavel"]), "motivo": r.get("motivo", "")}
    if not r["viavel"]:
        return out
    m = r["medidas"]
    out.update(
        dvTotal=_arred(r["dv_total"] * 1000),
        duracaoMin=_arred(r["t_total"] / 60),
        impulsos=[{"tMin": _arred(e["t"] / 60), "dv": _arred(e["dv"] * 1000), "desc": e["desc"]}
                  for e in r["eventos"]],
        medidas={
            "altMin": _arred(m["alt_min"], 0), "altMax": _arred(m["alt_max"], 0),
            "dMin": _arred(m["d_min"], 0), "dMax": _arred(m["d_max"], 0),
            "dFinal": _arred(m["d_final"]), "altFinal": _arred(m["alt_final"]),
            "dvRk4": _arred(m["dv_num_total"] * 1000),
        },
    )
    d = r.get("detalhe", {})
    if "h_fase" in d:
        out["detalhe"] = {"hFase": _arred(d["h_fase"], 0), "tEsperaMin": _arred(d["t_esp"] / 60),
                          "derivaKmH": _arred(abs(d["dn"]) * am.R_REF * 3600, 0)}
        mr = d.get("mais_rapido")
        if mr and abs(mr["t_total"] - r["t_total"]) > 60:
            out["alternativa"] = {"hFase": _arred(mr["h_fase"], 0),
                                  "dvTotal": _arred(mr["dv_total"] * 1000),
                                  "duracaoMin": _arred(mr["t_total"] / 60, 0)}
    elif "apogeu" in d:
        out["detalhe"] = {"perigeu": _arred(d["perigeu"], 0), "apogeu": _arred(d["apogeu"], 0)}
    return out


# ============================== SIMULADOR =====================================
class SimuladorUwb:
    """Gera linhas 'D,a,b,dist,rx,t' como a GS faria, para testar sem hardware.

    Bancada: GS na origem, Gabriella a 1,2 m. A Beatriz oscila em torno de 1,5 m e sai
    da banda de controle de tempos em tempos; a Carolina deriva devagar."""

    PARES = [(0, 1), (0, 2), (0, 3), (1, 2), (2, 3), (1, 3)]

    def __init__(self, intervalo_s=0.05, ruido_m=0.03):
        self.intervalo_s = intervalo_s
        self.ruido_m = ruido_m
        self.t0 = time.time()
        self.k = 0

    def _posicoes(self, t):
        d_b = 1.50 + 0.12 * math.sin(2 * math.pi * t / 90)
        d_c = 1.50 + 0.10 * math.sin(2 * math.pi * t / 240) + 0.02 * math.sin(2 * math.pi * t / 37)
        g = (1.2, 0.0)
        return {0: (0.0, 0.0), 2: g, 1: (g[0], d_b), 3: (g[0], -d_c)}

    def proxima_linha(self):
        time.sleep(self.intervalo_s)
        t = time.time() - self.t0
        p = self._posicoes(t)
        a, b = self.PARES[self.k % len(self.PARES)]
        self.k += 1
        d = math.dist(p[a], p[b]) + random.gauss(0, self.ruido_m)
        rx = -80 + random.gauss(0, 3)
        return f"D,{a},{b},{d:.3f},{rx:.1f},{int(t * 1000)}"
