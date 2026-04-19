const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const FILE = path.join(__dirname, 'buildcast.html');

const server = http.createServer((req, res) => {
  fs.readFile(FILE, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Server error: could not read buildcast.html');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`BuildCast is live on port ${PORT}`);
});
