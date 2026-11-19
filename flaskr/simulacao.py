# -*- coding: utf-8 -*-
"""
Simulação visual das manobras (botão SIMULAR do painel Manobras).

Recebe o estado TRAVADO de cada satélite (h, d até a Gabriella e a estratégia escolhida),
pede a manobra ao analisar_manobras.py (sem alterá-lo) e propaga as órbitas com RK4,
guardando a trajetória completa para o navegador animar:

  * posição inercial (x, y) [km] de cada satélite ao longo do tempo
  * altitude [km] e distância até a Gabriella [km]
  * instante e posição de cada impulso

Mesmo modelo do analisar_manobras.simular(): órbitas coplanares, dois corpos e impulsos
instantâneos. A Gabriella fica em órbita circular a H_REF, no ângulo N_REF * t (começa em 0).
"""
import math

from . import analisar_manobras as am

DT_INTEGRACAO_S = 5.0       # passo do RK4 [s]
DT_AMOSTRA_S = 30.0         # intervalo entre os pontos enviados ao navegador [s]
FOLGA_APOS_MANOBRA_S = am.T_REF   # continua propagando 1 órbita depois da última manobra
DURACAO_SEM_MANOBRA_S = 2 * am.T_REF
H_VALIDA = (100.0, 2000.0)  # faixa aceita para a altitude recebida [km]
D_VALIDA = (1.0, 2 * (am.R_TERRA + H_VALIDA[1]))


def _acel(x, y):
    r3 = (x * x + y * y) ** 1.5
    return -am.GM * x / r3, -am.GM * y / r3


def _rk4(x, y, vx, vy, h):
    a1x, a1y = _acel(x, y)
    k1 = (vx, vy, a1x, a1y)
    a2x, a2y = _acel(x + 0.5 * h * k1[0], y + 0.5 * h * k1[1])
    k2 = (vx + 0.5 * h * k1[2], vy + 0.5 * h * k1[3], a2x, a2y)
    a3x, a3y = _acel(x + 0.5 * h * k2[0], y + 0.5 * h * k2[1])
    k3 = (vx + 0.5 * h * k2[2], vy + 0.5 * h * k2[3], a3x, a3y)
    a4x, a4y = _acel(x + h * k3[0], y + h * k3[1])
    k4 = (vx + h * k3[2], vy + h * k3[3], a4x, a4y)
    return (x + h / 6 * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]),
            y + h / 6 * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]),
            vx + h / 6 * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]),
            vy + h / 6 * (k1[3] + 2 * k2[3] + 2 * k3[3] + k4[3]))


def propagar(phi0, h, eventos, t_fim):
    """Propaga um satélite que parte de órbita circular a altitude h e fase phi0,
    aplicando os impulsos como o analisar_manobras.simular(). Devolve as amostras."""
    R = am.R_TERRA + h
    v0 = math.sqrt(am.GM / R)
    x, y = R * math.cos(phi0), R * math.sin(phi0)
    vx, vy = -v0 * math.sin(phi0), v0 * math.cos(phi0)
    ev = sorted(eventos, key=lambda e: e["t"])
    k = 0
    t = 0.0
    impulsos = []
    amostras = {"x": [], "y": [], "alt": [], "dist": [], "v": [], "vr": []}

    def aplica_eventos():
        nonlocal k, vx, vy
        while k < len(ev) and ev[k]["t"] <= t + 1e-9:
            e = ev[k]
            k += 1
            vel = math.hypot(vx, vy)
            if e["tipo"] == "tang":
                fator = e["v_alvo"] / vel
                nvx, nvy = vx * fator, vy * fator
            else:
                r = math.hypot(x, y)
                vc = math.sqrt(am.GM / r)
                nvx, nvy = -vc * y / r, vc * x / r
            dvx, dvy = nvx - vx, nvy - vy
            vx, vy = nvx, nvy
            # componentes do ΔV no referencial local: radial (para fora da Terra) e
            # tangencial (positivo = prógrado, no sentido do movimento)
            r = math.hypot(x, y)
            dv_rad = (dvx * x + dvy * y) / r
            dv_tan = (-dvx * y + dvy * x) / r
            impulsos.append({"tH": round(t / 3600, 4), "x": round(x, 1), "y": round(y, 1),
                             "dv": round(math.hypot(dvx, dvy) * 1000, 2),
                             "dvRad": round(dv_rad * 1000, 2), "dvTan": round(dv_tan * 1000, 2),
                             "desc": e["desc"]})

    n_amostras = int(math.ceil(t_fim / DT_AMOSTRA_S))
    for i in range(n_amostras + 1):
        t_alvo = i * DT_AMOSTRA_S
        while t < t_alvo - 1e-9:
            aplica_eventos()
            prox = ev[k]["t"] if k < len(ev) and ev[k]["t"] < t_alvo else t_alvo
            passo = min(DT_INTEGRACAO_S, prox - t)
            if passo <= 1e-9:
                passo = min(DT_INTEGRACAO_S, t_alvo - t)
            x, y, vx, vy = _rk4(x, y, vx, vy, passo)
            t += passo
        aplica_eventos()
        r = math.hypot(x, y)
        gx = am.R_REF * math.cos(am.N_REF * t)
        gy = am.R_REF * math.sin(am.N_REF * t)
        amostras["x"].append(round(x, 1))
        amostras["y"].append(round(y, 1))
        amostras["alt"].append(round(r - am.R_TERRA, 2))
        amostras["dist"].append(round(math.hypot(x - gx, y - gy), 1))
        amostras["v"].append(round(math.hypot(vx, vy), 5))           # velocidade [km/s]
        amostras["vr"].append(round((vx * x + vy * y) / r, 5))       # componente radial [km/s]
    return amostras, impulsos


def _numero(valor, nome, faixa):
    try:
        v = float(valor)
    except (TypeError, ValueError) as erro:
        raise ValueError(f'"{nome}" deve ser numérico.') from erro
    if not math.isfinite(v) or not faixa[0] <= v <= faixa[1]:
        raise ValueError(f'"{nome}" fora da faixa aceita [{faixa[0]:.0f}, {faixa[1]:.0f}].')
    return v


def _resumo_estrategia(indice, r):
    return {"indice": indice, "nome": r["nome"], "dvTotal": round(r["dv_total"] * 1000, 1),
            "duracaoMin": round(r["t_total"] / 60, 1)}


def simular(pedido):
    """pedido = {"satelites": {"Beatriz": {"h": 400, "d": 1300, "estrategia": 2 | None}, ...}}
    estrategia = índice 0..2 (1º cruzamento, 2º cruzamento, faseamento); None = sem manobra."""
    satelites_in = pedido.get("satelites") if isinstance(pedido, dict) else None
    if not isinstance(satelites_in, dict) or not satelites_in:
        raise ValueError("Informe ao menos um satélite em \"satelites\".")

    planos = {}
    for nome, dados in satelites_in.items():
        if nome not in ("Beatriz", "Carolina") or not isinstance(dados, dict):
            raise ValueError(f"Satélite inválido: {nome}.")
        h = _numero(dados.get("h"), f"{nome}.h", H_VALIDA)
        d = _numero(dados.get("d"), f"{nome}.d", D_VALIDA)
        lado = "atras" if nome == "Beatriz" else "frente"
        est = am.estado_inicial(lado, h, d)
        pedida = dados.get("estrategia")
        plano = {"h": h, "d": d, "phi0": est["phi0"], "phiAlvo": est["phi_alvo"],
                 "eventos": [], "estrategia": None, "aviso": ""}
        if pedida is not None:
            if not isinstance(pedida, int) or not 0 <= pedida <= 2:
                raise ValueError(f"Estratégia inválida para {nome}.")
            res = am.analisar(nome, h, d, verbose=False, forcar=True) or []
            r = res[pedida] if pedida < len(res) else None
            if r and r["viavel"]:
                plano["eventos"] = r["eventos"]
                plano["estrategia"] = _resumo_estrategia(pedida, r)
                plano["tFim"] = r["t_total"]
            else:
                plano["aviso"] = (f"Estratégia {pedida + 1} não é viável neste estado; "
                                  "o satélite só segue na órbita atual.")
        planos[nome] = plano

    fins = [p["tFim"] for p in planos.values() if "tFim" in p]
    t_fim = max(fins) + FOLGA_APOS_MANOBRA_S if fins else DURACAO_SEM_MANOBRA_S

    saida = {}
    for nome, plano in planos.items():
        amostras, impulsos = propagar(plano["phi0"], plano["h"], plano["eventos"], t_fim)
        saida[nome] = {
            "hInicial": plano["h"], "dInicial": plano["d"],
            "phi0": plano["phi0"], "phiAlvo": plano["phiAlvo"],
            "manobra": plano["estrategia"] is not None,
            "estrategia": plano["estrategia"], "aviso": plano["aviso"],
            "impulsos": impulsos, **amostras,
        }

    return {
        "dtAmostraS": DT_AMOSTRA_S,
        "duracaoH": round(t_fim / 3600, 4),
        "nPontos": int(math.ceil(t_fim / DT_AMOSTRA_S)) + 1,
        "satelites": saida,
        "constantes": {
            "rTerra": am.R_TERRA, "hRef": am.H_REF, "rRef": am.R_REF, "nRef": am.N_REF,
            "dAlvo": am.D_ALVO, "alpha": am.ALPHA, "periodoH": am.T_REF / 3600,
            "altMax": am.ALT_MAX, "vRef": math.sqrt(am.GM / am.R_REF),
        },
    }
