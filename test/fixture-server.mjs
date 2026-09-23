import { createServer } from "node:http";

const origin = "http://127.0.0.1:8765";

createServer((request, response) => {
  const path = new URL(request.url, origin).pathname;

  if (path === "/pass" || path === "/noindex") {
    const noindex = path === "/noindex" ? '<meta name="robots" content="noindex">' : "";
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html><head><link rel="canonical" href="${origin}${path}">${noindex}<title>Fixture</title></head><body><h1>Fixture</h1></body></html>`);
    return;
  }

  if (path === "/header-noindex") {
    response.writeHead(200, { "content-type": "application/pdf", "x-robots-tag": "googlebot: noindex" });
    response.end("%PDF-1.7");
    return;
  }

  // /robots.txt and /missing intentionally return 404.
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found");
}).listen(8765, "127.0.0.1", () => {
  console.log(`Fixture ready at ${origin}`);
});
