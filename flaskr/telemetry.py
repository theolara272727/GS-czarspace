"""Parsing comum às duas portas, com campos definidos pelos modos cadastrados."""
import json
import math
import re
from datetime import datetime, timezone


def _normalize_mode_code(value):
    if isinstance(value, int) and not isinstance(value, bool):
        number = value
    elif isinstance(value, str):
        candidate = value.strip()
        if not re.fullmatch(r'(?:0[xX])?[0-9a-fA-F]+', candidate):
            raise ValueError('O código do modo deve ser hexadecimal (ex.: 0x01).')
        number = int(candidate, 16)
    else:
        raise ValueError('O código do modo é obrigatório.')
    if number < 0:
        raise ValueError('O código do modo não pode ser negativo.')
    return f'0x{number:X}'


def _normalize_timestamp(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        seconds = value / 1000 if value > 10_000_000_000 else value
        return datetime.fromtimestamp(seconds, timezone.utc).isoformat()
    if not isinstance(value, str) or not value.strip():
        raise ValueError('A timestamp de coleta é obrigatória.')
    candidate = value.strip()
    if re.fullmatch(r'\d+(?:\.\d+)?', candidate):
        numeric_value = float(candidate)
        seconds = numeric_value / 1000 if numeric_value > 10_000_000_000 else numeric_value
        return datetime.fromtimestamp(seconds, timezone.utc).isoformat()
    parsed = datetime.fromisoformat(candidate.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat()


def parse_serial_message(raw_message, modes, use_received_timestamp=False):
    if isinstance(raw_message, bytes):
        raw_message = raw_message.decode('utf-8')
    if not isinstance(raw_message, str) or not raw_message.strip():
        raise ValueError('Mensagem serial vazia.')
    text = raw_message.strip()
    if text.startswith('{'):
        message = json.loads(text)
        if not isinstance(message, dict):
            raise ValueError('A mensagem de telemetria deve ser um objeto JSON.')
        collected_at = message.get('timestamp', message.get('collectedAt'))
        mode_code = message.get('modeCode', message.get('mode', message.get('code')))
        values = message.get('values', message.get('data'))
    else:
        fields = text.split()
        if len(fields) < 3:
            raise ValueError('Formato esperado: timestamp código_hex valor1 valor2 ...')
        collected_at, mode_code, *values = fields

    if not isinstance(values, list):
        raise ValueError('O campo "values" deve ser uma lista.')
    normalized_code = _normalize_mode_code(mode_code)
    mode = next((item for item in modes if item.get('code') == normalized_code), None)
    if mode is None:
        raise ValueError(f'Não existe configuração para o modo {normalized_code}.')
    data_types = mode.get('dataTypes', [])
    if len(values) != len(data_types):
        raise ValueError(
            f'O modo {normalized_code} espera {len(data_types)} valores, mas recebeu {len(values)}.'
        )
    try:
        telemetry = {name: float(value) for name, value in zip(data_types, values)}
    except (TypeError, ValueError) as error:
        raise ValueError('Todos os valores de telemetria devem ser numéricos.') from error
    telemetry = {
        name: value if math.isfinite(value) else None
        for name, value in telemetry.items()
    }
    timestamp = _normalize_timestamp(collected_at)
    received = datetime.now(timezone.utc).isoformat()
    packet = {
        'timestamp': received if use_received_timestamp else timestamp,
        'receivedTimestamp': received,
        'modeCode': normalized_code,
        'modeName': mode.get('name', normalized_code),
        'values': telemetry,
    }
    if use_received_timestamp:
        try:
            packet['deviceTimestamp'] = float(collected_at)
        except (TypeError, ValueError):
            packet['deviceTimestamp'] = collected_at
    return packet
