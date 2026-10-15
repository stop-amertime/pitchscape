"""usage: OPENROUTER_API_KEY=... python3 tools/check_line_order.py WORKDIR [model]
Optional sanity check. Sends the isolated vocal plus the distinct lyric lines to an audio-capable model on OpenRouter
and asks which line is sung when. Its timestamps are rough (seconds off), so they are NOT used for timing; the point is
to confirm the sung order matches the written lyrics. If it doesn't (extra chorus repeats, skipped lines), edit the
lyrics file into sung order and rerun prepare_lyrics.js before aligning."""
import json, base64, os, sys, subprocess, urllib.request
work = sys.argv[1]; model = sys.argv[2] if len(sys.argv) > 2 else 'google/gemini-3.8-flash'
key = os.environ.get('OPENROUTER_API_KEY') or sys.exit('set OPENROUTER_API_KEY')
mp3 = os.path.join(work, 'vocals.mp3')
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', os.path.join(work, 'stems', 'vocals.wav'), '-ac', '1', '-ar', '22050', '-b:a', '64k', mp3], check=True)
lines = json.load(open(os.path.join(work, 'lines.json')))
numbered = '\n'.join(f'{i + 1}. {t}' for i, t in enumerate(lines))
prompt = f"""The audio is the isolated lead vocal of a song (other instruments were removed, so there may be faint bleed and silence).
Here are the distinct lyric lines, numbered:
{numbered}

List EVERY time one of these lines is sung, in the order they happen. Lines can repeat more often than you'd expect, and may be skipped. Ignore ad-libs and wordless vocals.
For each occurrence give the line number and when it starts and ends, in seconds.
Reply with JSON only: {{"occurrences":[{{"line":1,"start":0.0,"end":0.0}}]}}"""
body = {'model': model, 'temperature': 0, 'response_format': {'type': 'json_object'},
        'messages': [{'role': 'user', 'content': [{'type': 'text', 'text': prompt},
                      {'type': 'input_audio', 'input_audio': {'data': base64.b64encode(open(mp3, 'rb').read()).decode(), 'format': 'mp3'}}]}]}
req = urllib.request.Request('https://openrouter.ai/api/v1/chat/completions', data=json.dumps(body).encode(),
                             headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
txt = json.load(urllib.request.urlopen(req, timeout=300))['choices'][0]['message']['content']
occ = json.loads(txt[txt.index('{'): txt.rindex('}') + 1])['occurrences']
json.dump(occ, open(os.path.join(work, 'sung_order.json'), 'w'))
written = json.load(open(os.path.join(work, 'written.json')))
first = {}; seq = []
for w in written:
    first.setdefault(w['h'], len(first) + 1); seq.append(first[w['h']])
heard = [o['line'] for o in occ]
print('written order:', seq)
print('heard order:  ', heard)
print('MATCH: safe to align' if heard == seq else 'DIFFERENT: put the lyrics file in sung order (repeat or drop lines), rerun prepare_lyrics.js, then align')
