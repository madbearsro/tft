<?php
$p = trim($_GET['p'] ?? '');

if (!$p || !preg_match('/^[a-z0-9\/_.@%-]+$/i', $p)) {
    http_response_code(400);
    exit;
}

if (strpos($p, '..') !== false || strpos($p, '\\') !== false) {
    http_response_code(400);
    exit;
}

$cacheDir = __DIR__ . '/cache/img';
$cacheKey  = md5($p);
$cacheFile = "{$cacheDir}/{$cacheKey}.bin";
$metaFile  = "{$cacheDir}/{$cacheKey}.meta";
$CACHE_TTL = 86400;

if (mt_rand(1, 50) === 1 && is_dir($cacheDir)) {
    $handle = opendir($cacheDir);
    if ($handle) {
        $cutoff = time() - $CACHE_TTL;
        while (($file = readdir($handle)) !== false) {
            if (substr($file, -4) !== '.bin') continue;
            $path = $cacheDir . '/' . $file;
            if (filemtime($path) < $cutoff) {
                @unlink($path);
                @unlink(substr($path, 0, -4) . '.meta');
            }
        }
        closedir($handle);
    }
}

if (is_file($cacheFile) && is_file($metaFile) && (time() - filemtime($cacheFile)) < $CACHE_TTL) {
    $meta = json_decode(file_get_contents($metaFile), true);
    header('Content-Type: ' . ($meta['ct'] ?? 'image/png'));
    header('Cache-Control: public, max-age=86400');
    header('X-Cache: HIT');
    readfile($cacheFile);
    exit;
}

$base = $_GET['base'] ?? 'cd';
if ($base === 'dd') {
    $ver = trim($_GET['ver'] ?? '');
    if (!$ver || !preg_match('/^\d+\.\d+\.\d+$/', $ver)) { http_response_code(400); exit; }
    $url = 'https://ddragon.leagueoflegends.com/cdn/' . $ver . '/img/' . $p;
} else {
    $url = 'https://raw.communitydragon.org/latest/game/' . $p;
}

$data = false;
if (function_exists('curl_init')) {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_TIMEOUT        => 10,
        CURLOPT_HTTPHEADER     => ['User-Agent: TFT-Helper/1.0'],
        CURLOPT_SSL_VERIFYPEER => true,
    ]);
    $data = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($code !== 200) $data = false;
} else {
    $ctx = stream_context_create(['http' => ['timeout' => 10, 'header' => "User-Agent: TFT-Helper/1.0\r\n"]]);
    $data = @file_get_contents($url, false, $ctx);
}

if ($data === false) {
    http_response_code(404);
    exit;
}

$ext = strtolower(pathinfo($p, PATHINFO_EXTENSION));
$ct  = ['png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg',
        'gif' => 'image/gif', 'webp' => 'image/webp'][$ext] ?? 'image/png';

if (!is_dir($cacheDir)) mkdir($cacheDir, 0755, true);
file_put_contents($cacheFile, $data);
file_put_contents($metaFile, json_encode(['ct' => $ct]));

header('Content-Type: ' . $ct);
header('Cache-Control: public, max-age=86400');
header('Access-Control-Allow-Origin: *');
header('X-Cache: MISS');
echo $data;
