"""A song from a link, for POST /analyze with a `url` instead of a file (server/modal_app.py and server/local.py).

Direct audio files only (an archive.org .mp3, say), plus Google Drive and Dropbox share links, which are turned into
their download links; a web page (YouTube, Spotify, a Drive file that isn't public) is refused, not read.

The server fetches whatever it is asked to, so it only connects to public addresses: the host name is looked up, every
address it has must be public (no private, loopback, link-local or cloud metadata addresses), and the connection goes
to the address that was checked, so a second lookup cannot swap in an internal one. Redirects are followed by hand and
each is checked the same way. Standard library only, so the Modal web container needs nothing more installed.
"""
import email.message, http.client, ipaddress, os, re, socket, ssl, time, urllib.parse

LIMIT = 80_000_000          # the same as an upload
TIMEOUT = 60                # seconds for the whole download
REDIRECTS = 5
AGENT = 'Pitchscape/1 (+https://stop-amertime.github.io/pitchscape/)'
EXT = {'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac',
       'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav', 'audio/flac': '.flac', 'audio/x-flac': '.flac',
       'audio/ogg': '.ogg', 'application/ogg': '.ogg', 'audio/opus': '.opus', 'audio/webm': '.webm'}


class Refused(Exception):
    """Why a link can't be opened, in words for the page; `status` is the HTTP status the server answers with."""
    status = 400


class TooBig(Refused):
    status = 413


class Failed(Refused):
    status = 502


def direct(url):
    """A Google Drive or Dropbox share link as the link to the file itself; any other link as it is."""
    u = urllib.parse.urlsplit(url)
    host = (u.hostname or '').lower()
    if host in ('drive.google.com', 'docs.google.com'):
        m = re.search(r'/file/d/([\w-]+)', u.path)
        fid = m.group(1) if m else urllib.parse.parse_qs(u.query).get('id', [None])[0]
        if fid:
            return 'https://drive.usercontent.google.com/download?' + urllib.parse.urlencode(
                {'id': fid, 'export': 'download', 'confirm': 't'})
    if host in ('dropbox.com', 'www.dropbox.com'):
        q = [(k, v) for k, v in urllib.parse.parse_qsl(u.query) if k not in ('dl', 'raw')] + [('dl', '1')]
        return urllib.parse.urlunsplit((u.scheme, u.netloc, u.path, urllib.parse.urlencode(q), ''))
    return url


def public_ip(host, port):
    """The address to connect to for host, once every address it has is known to be public."""
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError):
        raise Failed("Couldn't find %s. Check the link." % host)
    ips = []
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split('%')[0])
        if getattr(ip, 'ipv4_mapped', None):
            ip = ip.ipv4_mapped
        if not ip.is_global or ip.is_multicast:
            raise Refused("That link points inside a private network, which the server won't open.")
        ips.append(str(ip))
    if not ips:
        raise Failed("Couldn't find %s. Check the link." % host)
    return ips[0]


class _HTTP(http.client.HTTPConnection):
    def __init__(self, host, port, ip, timeout):
        super().__init__(host, port, timeout=timeout)
        self.ip = ip

    def connect(self):
        self.sock = socket.create_connection((self.ip, self.port), self.timeout)


class _HTTPS(http.client.HTTPSConnection):
    """HTTPS to the checked address, with the certificate checked against the host name."""
    def __init__(self, host, port, ip, timeout):
        super().__init__(host, port, timeout=timeout, context=ssl.create_default_context())
        self.ip = ip

    def connect(self):
        sock = socket.create_connection((self.ip, self.port), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


def _name(resp, url, ctype):
    """The file's name: as the host gives it for the download, else the last part of the link."""
    msg = email.message.Message()
    msg['content-disposition'] = resp.getheader('Content-Disposition', '')
    name = msg.get_filename() or urllib.parse.unquote(urllib.parse.urlsplit(url).path.rstrip('/').rsplit('/', 1)[-1])
    name = os.path.basename(name.replace('\\', '/')).strip() or 'song'
    if not os.path.splitext(name)[1]:
        name += EXT.get(ctype, '.mp3')
    return name


def fetch(url, limit=None, timeout=None):
    """(bytes, file name) of the audio file at url, or Refused / TooBig / Failed with the reason in plain words."""
    limit, timeout = limit or LIMIT, timeout or TIMEOUT
    url = direct(url.strip())
    drive = 'drive.usercontent.google.com' in url
    deadline = time.monotonic() + timeout
    for _ in range(REDIRECTS + 1):
        u = urllib.parse.urlsplit(url)
        if u.scheme not in ('http', 'https') or not u.hostname:
            raise Refused('Only http and https links to audio files can be opened.')
        try:
            port = u.port or (443 if u.scheme == 'https' else 80)
        except ValueError:
            raise Refused('That link has a broken port number.')
        ip = public_ip(u.hostname, port)
        conn = (_HTTPS if u.scheme == 'https' else _HTTP)(u.hostname, port, ip, min(20, timeout))
        try:
            conn.request('GET', (u.path or '/') + ('?' + u.query if u.query else ''),
                         headers={'User-Agent': AGENT, 'Accept': 'audio/*, application/octet-stream;q=0.9, */*;q=0.5'})
            resp = conn.getresponse()
            if resp.status in (301, 302, 303, 307, 308) and resp.getheader('Location'):
                url = urllib.parse.urljoin(url, resp.getheader('Location'))
                continue
            ctype = (resp.getheader('Content-Type') or '').split(';')[0].strip().lower()
            if drive and (resp.status in (401, 403, 404) or ctype == 'text/html'):
                raise Refused("That Drive file isn't shared publicly. In Drive, share it with Anyone with the link.")
            if resp.status == 404:
                raise Failed('Nothing is at that link (404). Check it opens the file in a browser.')
            if resp.status != 200:
                raise Failed('The link answered %d %s.' % (resp.status, resp.reason or ''))
            if ctype.startswith('text/') or any(w in ctype for w in ('html', 'json', 'xml')):
                raise Refused('That link is a web page, not an audio file. Use a link that ends in the file, like .mp3.')
            n = resp.getheader('Content-Length')
            if n and n.isdigit() and int(n) > limit:
                raise TooBig('That file is over %d MB.' % (limit // 1_000_000))
            chunks, got = [], 0
            while True:
                if time.monotonic() > deadline:
                    raise Failed('The download took over %d seconds, so it was stopped.' % timeout)
                b = resp.read(1 << 16)
                if not b:
                    break
                got += len(b)
                if got > limit:
                    raise TooBig('That file is over %d MB.' % (limit // 1_000_000))
                chunks.append(b)
            if not got:
                raise Failed('The link sent an empty file.')
            return b''.join(chunks), _name(resp, url, ctype)
        except (OSError, http.client.HTTPException) as e:
            if isinstance(e, socket.timeout) or 'timed out' in str(e):
                raise Failed('The site stopped answering, so the download was stopped.')
            raise Failed("Couldn't download it (%s)." % (type(e).__name__ + (': ' + str(e) if str(e) else ''))[:160])
        finally:
            conn.close()
    raise Failed('That link redirects too many times.')
