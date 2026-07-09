import http.server
import socketserver
import urllib.request
import urllib.parse
import json
import os
import re
import time
import random
from concurrent.futures import ThreadPoolExecutor

PORT = 8000

# Ensure temp directory exists
os.makedirs('temp_audio', exist_ok=True)

def clean_text(text):
    # Keep Korean, English, numbers, spaces, and basic punctuation marks
    cleaned = re.sub(r'[^가-힣ㄱ-ㅎㅏ-ㅣa-zA-Z0-9\s.,!?]', '', text)
    # Clean multiple spaces into a single space
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    return cleaned

def detect_lang(text):
    # If text has any Hangul character, treat as Korean ('ko')
    for char in text:
        val = ord(char)
        if (0xAC00 <= val <= 0xD7A3) or (0x1100 <= val <= 0x11FF) or (0x3130 <= val <= 0x318F):
            return 'ko'
    return 'en'

def split_text(text, max_len=100):
    # 1. Split by sentence endings (.!? or newlines)
    sentences = re.split(r'([.!?]+|\n+)', text)
    raw_chunks = []
    current_chunk = ""
    for part in sentences:
        if not part:
            continue
        if re.match(r'^[.!?\n]+$', part):
            current_chunk += part
            if current_chunk.strip():
                raw_chunks.append(current_chunk.strip())
            current_chunk = ""
        else:
            current_chunk += part
    if current_chunk.strip():
        raw_chunks.append(current_chunk.strip())
        
    # 2. If any raw chunk is longer than max_len, sub-split it by spaces (words)
    split_raw_chunks = []
    for chunk in raw_chunks:
        if len(chunk) > max_len:
            words = chunk.split(' ')
            temp = ""
            for word in words:
                if len(temp) + len(word) + 1 > max_len:
                    if temp.strip():
                        split_raw_chunks.append(temp.strip())
                    temp = word
                else:
                    if temp:
                        temp += " " + word
                    else:
                        temp = word
            if temp.strip():
                split_raw_chunks.append(temp.strip())
        else:
            split_raw_chunks.append(chunk)
            
    # 3. Group raw chunks together up to max_len
    grouped_chunks = []
    temp_chunk = ""
    for chunk in split_raw_chunks:
        if len(temp_chunk) + len(chunk) + 1 > max_len:
            if temp_chunk:
                grouped_chunks.append(temp_chunk)
            temp_chunk = chunk
        else:
            if temp_chunk:
                temp_chunk += " " + chunk
            else:
                temp_chunk = chunk
    if temp_chunk:
        grouped_chunks.append(temp_chunk)
        
    return grouped_chunks

def fetch_chunk_audio(chunk, index):
    lang = detect_lang(chunk)
    encoded_chunk = urllib.parse.quote(chunk)
    url = f"https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl={lang}&q={encoded_chunk}"
    
    req = urllib.request.Request(
        url, 
        headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
    )
    
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            return index, res.read()
    except Exception as e:
        print(f"Error fetching chunk {index}: {e}")
        return index, b""

class ClarityReaderHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        # 1. API Route for single sentence TTS streaming (Instant play)
        if self.path.startswith('/api/tts_single'):
            try:
                parsed_url = urllib.parse.urlparse(self.path)
                params = urllib.parse.parse_qs(parsed_url.query)
                
                text = params.get('q', [''])[0]
                if not text.strip():
                    self.send_response(400)
                    self.send_header('Content-Type', 'application/json; charset=utf-8')
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": "텍스트를 입력해 주세요."}, ensure_ascii=False).encode('utf-8'))
                    return
                
                cleaned = clean_text(text)
                lang = params.get('l', [''])[0]
                if not lang or lang == 'auto':
                    lang = detect_lang(cleaned)
                
                encoded_chunk = urllib.parse.quote(cleaned)
                url = f"https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl={lang}&q={encoded_chunk}"
                
                req = urllib.request.Request(
                    url, 
                    headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
                )
                
                with urllib.request.urlopen(req, timeout=5) as res:
                    audio_data = res.read()
                
                self.send_response(200)
                self.send_header('Content-Type', 'audio/mpeg')
                self.end_headers()
                self.wfile.write(audio_data)
                
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}, ensure_ascii=False).encode('utf-8'))
            return

        # 2. API Route for translation proxy
        if self.path.startswith('/api/translate'):
            parsed_url = urllib.parse.urlparse(self.path)
            params = urllib.parse.parse_qs(parsed_url.query)
            
            text = params.get('q', [''])[0]
            target_lang = params.get('tl', ['ko'])[0]
            source_lang = params.get('sl', ['auto'])[0]
            
            if not text:
                self.send_response(400)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Missing query parameter 'q'"}).encode('utf-8'))
                return
                
            try:
                encoded_text = urllib.parse.quote(text)
                url = f"https://translate.googleapis.com/translate_a/single?client=gtx&sl={source_lang}&tl={target_lang}&dt=t&q={encoded_text}"
                
                req = urllib.request.Request(
                    url, 
                    headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
                )
                
                with urllib.request.urlopen(req) as response:
                    res_body = response.read()
                
                google_data = json.loads(res_body.decode('utf-8'))
                
                translated_text = ""
                if google_data and google_data[0]:
                    for segment in google_data[0]:
                        if segment[0]:
                            translated_text += segment[0]
                
                result = {
                    "original": text,
                    "translated": translated_text,
                    "source_lang": google_data[2] if len(google_data) > 2 else source_lang
                }
                
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.end_headers()
                self.wfile.write(json.dumps(result, ensure_ascii=False).encode('utf-8'))
                
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode('utf-8'))
            return
            
        # Default static file server behavior
        return super().do_GET()

    def do_POST(self):
        if self.path == '/api/tts':
            try:
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
                req_data = json.loads(post_data.decode('utf-8'))
                
                raw_text = req_data.get('text', '')
                if not raw_text.strip():
                    self.send_response(400)
                    self.send_header('Content-Type', 'application/json; charset=utf-8')
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": "텍스트를 입력해 주세요."}, ensure_ascii=False).encode('utf-8'))
                    return
                
                cleaned = clean_text(raw_text)
                if not cleaned:
                    self.send_response(400)
                    self.send_header('Content-Type', 'application/json; charset=utf-8')
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": "필터링 후 읽을 수 있는 텍스트가 없습니다."}, ensure_ascii=False).encode('utf-8'))
                    return
                
                # 2. Split text into segments
                chunks = split_text(cleaned)
                
                # 3. Request Google Translate TTS in PARALLEL using ThreadPoolExecutor
                timestamp = int(time.time())
                rand_id = random.randint(1000, 9999)
                
                with ThreadPoolExecutor(max_workers=10) as executor:
                    results = list(executor.map(lambda item: fetch_chunk_audio(item[1], item[0]), enumerate(chunks)))
                
                # Re-sort results to ensure correct chunk sequence
                results.sort(key=lambda x: x[0])
                
                combined_audio = bytearray()
                for index, audio_bytes in results:
                    combined_audio.extend(audio_bytes)
                
                if len(combined_audio) == 0:
                    self.send_response(500)
                    self.send_header('Content-Type', 'application/json; charset=utf-8')
                    self.end_headers()
                    self.wfile.write(json.dumps({"error": "음성 변환에 실패했습니다."}, ensure_ascii=False).encode('utf-8'))
                    return
                
                # 4. Save combined binary as mp3 file
                combined_filename = f"tts_combined_{timestamp}_{rand_id}.mp3"
                combined_filepath = os.path.join('temp_audio', combined_filename)
                with open(combined_filepath, 'wb') as f:
                    f.write(combined_audio)
                
                # 5. Clean up files older than 1 hour (3600 seconds)
                now = time.time()
                for item in os.listdir('temp_audio'):
                    item_path = os.path.join('temp_audio', item)
                    if os.path.isfile(item_path) and (item.startswith('tts_chunk_') or item.startswith('tts_combined_')) and item.endswith('.mp3'):
                        if now - os.path.getmtime(item_path) > 3600:
                            try:
                                os.remove(item_path)
                            except Exception as rm_err:
                                print(f"Error removing old temp file {item_path}: {rm_err}")
                
                # 6. Respond with combined audio URL
                result = {
                    "audioUrl": f"/temp_audio/{combined_filename}"
                }
                
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.end_headers()
                self.wfile.write(json.dumps(result, ensure_ascii=False).encode('utf-8'))
                
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}, ensure_ascii=False).encode('utf-8'))
            return
            
        self.send_response(404)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({"error": "Not Found"}).encode('utf-8'))
        return


# Ensure we are serving files from the directory where this script is located
os.chdir(os.path.dirname(os.path.abspath(__file__)))

# Configure server
handler = ClarityReaderHandler
# Allow socket reuse immediately on restart to prevent 'Address already in use'
socketserver.TCPServer.allow_reuse_address = True

with socketserver.TCPServer(("", PORT), handler) as httpd:
    print(f"ClarityReader API Server serving on http://localhost:{PORT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server.")
        httpd.server_close()
