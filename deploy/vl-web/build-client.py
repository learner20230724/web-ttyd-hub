#!/usr/bin/env python3
"""Add touchscreen keys to the web client embedded in the installed ttyd."""
import pathlib
import subprocess
import sys
import tempfile

with tempfile.TemporaryDirectory() as temporary:
    socket = pathlib.Path(temporary) / "factory.sock"
    server = subprocess.Popen(
        ["ttyd", "-i", str(socket), "/bin/true"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        client = subprocess.check_output([
            "curl", "-fsS", "--retry", "5", "--retry-all-errors", "--retry-delay", "1",
            "--compressed", "--unix-socket", str(socket), "http://localhost/",
        ]).decode()
    finally:
        server.terminate()
        server.wait(timeout=5)

viewport = '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content">'
keys = pathlib.Path(__file__).with_name("mobile.html").read_text()
if client.count("</head>") != 1 or client.count("</body>") != 1:
    raise SystemExit("Unexpected ttyd client structure")
client = client.replace('<html lang="en">', '<html lang="zh-CN">')
client = client.replace("</head>", viewport + "</head>").replace("</body>", keys + "</body>")
pathlib.Path(sys.argv[1]).write_text(client)
