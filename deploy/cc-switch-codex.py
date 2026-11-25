#!/usr/bin/python3
"""Use the CC Switch selection for Linux Hub launches without rewriting Codex files."""
import http.client
import json
import os
from pathlib import Path
import sys
import tomllib
from urllib.parse import urlsplit


DEFAULT_PROVIDER = 'hub-original-login'
MANAGED_PROVIDER = 'hub_cc_switch'
KEY_ENV = 'HUB_CC_SWITCH_PROVIDER_KEY'


def read_api(connection, authorization, route):
    connection.request('GET', f'/cc-switch/api/providers/codex{route}',
                       headers={'Authorization': authorization})
    with connection.getresponse() as response:
        limit = 4 * 1024 * 1024
        body = response.read(limit + 1)
        if response.status != 200 or len(body) > limit:
            raise OSError('CC Switch provider API is unavailable')
    return json.loads(body)


def selected_provider():
    auth_file = Path(os.environ.get('CC_SWITCH_AUTH_FILE', '/etc/cc-switch-web/upstream-auth'))
    authorization = auth_file.read_text().strip()
    port = int(os.environ.get('CC_SWITCH_PORT', '17666'))
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
    try:
        current = read_api(connection, authorization, '/current')
        if not current or current == DEFAULT_PROVIDER:
            return None
        return read_api(connection, authorization, '')[current]
    finally:
        connection.close()


def checked_string(value):
    if not isinstance(value, str) or not value.strip() or not value.isprintable():
        raise ValueError('Invalid provider field')
    return value


def provider_overrides(provider):
    settings = provider['settingsConfig']
    config = tomllib.loads(settings['config'])
    name = checked_string(config['model_provider'])
    definition = config['model_providers'][name]
    base_url = checked_string(definition['base_url'])
    url = urlsplit(base_url)
    loopback = url.hostname in {'127.0.0.1', 'localhost', '::1'}
    if not url.hostname or url.username or url.password or url.query or url.fragment:
        raise ValueError('Invalid provider URL')
    if url.scheme != 'https' and not (url.scheme == 'http' and loopback):
        raise ValueError('Provider URL must use HTTPS or loopback HTTP')
    if definition.get('wire_api', 'responses') != 'responses':
        raise ValueError('Provider must support the Responses API')
    key = checked_string(settings['auth']['OPENAI_API_KEY'])
    prefix = f'model_providers.{MANAGED_PROVIDER}'
    overrides = {
        'model_provider': MANAGED_PROVIDER,
        'model': checked_string(config['model']),
        f'{prefix}.name': checked_string(provider['name']),
        f'{prefix}.base_url': base_url,
        f'{prefix}.wire_api': 'responses',
        f'{prefix}.env_key': KEY_ENV,
        f'{prefix}.requires_openai_auth': False,
    }
    effort = config.get('model_reasoning_effort')
    if effort in ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'):
        overrides['model_reasoning_effort'] = effort
    args = []
    for field, value in overrides.items():
        args.extend(['-c', f'{field}={json.dumps(value, ensure_ascii=False)}'])
    return args, key


def main():
    codex = os.environ.get('CC_SWITCH_CODEX_BIN', '/usr/local/bin/codex')
    try:
        provider = selected_provider()
    except (OSError, http.client.HTTPException, ValueError, KeyError):
        print('CC Switch 暂不可用，本次沿用 Terminal Hub 原有 Codex 配置。', file=sys.stderr)
        provider = None
    args = []
    if provider is not None:
        try:
            args, key = provider_overrides(provider)
        except (KeyError, TypeError, ValueError):
            raise SystemExit('CC Switch 当前供应商需要有效的 Responses API 地址、模型和 API Key。') from None
        os.environ[KEY_ENV] = key
    os.execv(codex, [codex, *args, *sys.argv[1:]])


if __name__ == '__main__':
    main()
