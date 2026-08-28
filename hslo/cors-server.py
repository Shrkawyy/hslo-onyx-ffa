from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import mimetypes

HOST = "127.0.0.1"
PORT = 8765

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".user.js")
mimetypes.add_type("application/json", ".json")
mimetypes.add_type("image/png", ".png")
mimetypes.add_type("audio/mpeg", ".mp3")
mimetypes.add_type("application/wasm", ".wasm")


class CorsHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def guess_type(self, path):
        if str(path).endswith(".user.js"):
            return "text/javascript"
        return super().guess_type(path)


if __name__ == "__main__":
    httpd = ThreadingHTTPServer((HOST, PORT), CorsHandler)
    print("HSLO CORS server http://%s:%s/" % (HOST, PORT))
    httpd.serve_forever()
