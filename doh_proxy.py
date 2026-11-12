"""
极简 DNS-over-HTTPS 代理，监听 127.0.0.1:5353
由 server.js 的 /dns-query 路由转发请求过来
"""
import json, socket, sys
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

PORT = 5353


def resolve(name, qtype='A'):
    """用系统 DNS 解析域名，返回 IP 列表"""
    try:
        if qtype == 'A':
            info = socket.getaddrinfo(name, None, socket.AF_INET, socket.SOCK_STREAM)
            ips = list(set(addr[4][0] for addr in info))
            return ips, None
        elif qtype == 'AAAA':
            info = socket.getaddrinfo(name, None, socket.AF_INET6, socket.SOCK_STREAM)
            ips = list(set(addr[4][0] for addr in info))
            return ips, None
    except socket.gaierror as e:
        return [], str(e)
    return [], 'unsupported type'


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        name = params.get('name', [None])[0]
        qtype = params.get('type', ['A'])[0]

        if not name:
            self._reply({'Status': 2, 'Comment': 'missing name'}, 400)
            return

        ips, error = resolve(name, qtype)

        answer = []
        if ips:
            for ip in ips:
                answer.append({'name': name, 'type': 1, 'TTL': 300, 'data': ip})

        result = {
            'Status': 0 if answer else (2 if error else 3),
            'TC': False, 'RD': True, 'RA': True, 'AD': False, 'CD': False,
            'Question': [{'name': f'{name}.', 'type': 1}],
            'Answer': answer,
        }
        if error:
            result['Comment'] = error

        self._reply(result)

    def _reply(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/dns-json')
        self.send_header('Content-Length', len(data))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        name = self.path.split('name=')[1].split('&')[0] if 'name=' in self.path else '?'
        print(f'  [doh] {name}')


if __name__ == '__main__':
    server = HTTPServer(('127.0.0.1', PORT), Handler)
    print(f'DoH proxy on 127.0.0.1:{PORT}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nstopped.')
