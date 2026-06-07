<?php
// Configureaza aici username-ul si repo-ul tau GitHub
define('GITHUB_USER', 'madbearsro');
define('GITHUB_REPO', 'tft');
define('GITHUB_BRANCH', 'main');
define('GITHUB_RAW', 'https://raw.githubusercontent.com/' . GITHUB_USER . '/' . GITHUB_REPO . '/' . GITHUB_BRANCH . '/data');

// Cache local pe server (secunde) — reduce cererile catre GitHub
define('LOCAL_CACHE_TTL', 120); // 2 minute
define('CACHE_DIR', __DIR__ . '/cache');

function httpGet($url, $timeout = 10) {
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_TIMEOUT        => $timeout,
            CURLOPT_HTTPHEADER     => ['User-Agent: TFT-Helper-PHP/1.0'],
            CURLOPT_SSL_VERIFYPEER => true,
        ]);
        $data = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        return ($data !== false && $code === 200) ? $data : false;
    }
    // Fallback: file_get_contents (necesita allow_url_fopen = On)
    $ctx = stream_context_create(['http' => ['timeout' => $timeout, 'header' => "User-Agent: TFT-Helper-PHP/1.0\r\n"]]);
    return @file_get_contents($url, false, $ctx);
}

function fetchFromGithub($filename) {
    $url = GITHUB_RAW . '/' . $filename;
    $cacheFile = CACHE_DIR . '/' . str_replace('/', '_', $filename);

    // Verifica cache local
    if (is_file($cacheFile) && (time() - filemtime($cacheFile)) < LOCAL_CACHE_TTL) {
        return file_get_contents($cacheFile);
    }

    $data = httpGet($url);

    if ($data === false) {
        // Daca fetch esueaza, incearca sa returneze cache-ul vechi
        if (is_file($cacheFile)) return file_get_contents($cacheFile);
        return null;
    }

    // Salveaza cache local
    if (!is_dir(CACHE_DIR)) mkdir(CACHE_DIR, 0755, true);
    file_put_contents($cacheFile, $data);

    return $data;
}

function sendJson($data, $status = 200) {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, OPTIONS');
    header('Cache-Control: public, max-age=60');
    if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { exit; }
    echo $data;
    exit;
}

function sendError($msg, $status = 503) {
    sendJson(json_encode(['error' => $msg]), $status);
}
