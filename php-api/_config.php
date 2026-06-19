<?php
define('GITHUB_USER', 'madbearsro');
define('GITHUB_REPO', 'tft');
define('GITHUB_BRANCH', 'main');
define('GITHUB_RAW', 'https://raw.githubusercontent.com/' . GITHUB_USER . '/' . GITHUB_REPO . '/' . GITHUB_BRANCH . '/data');
define('GITHUB_API', 'https://api.github.com/repos/' . GITHUB_USER . '/' . GITHUB_REPO . '/contents/data');
define('LOCAL_DATA_DIR', realpath(__DIR__ . '/../data'));

define('LOCAL_CACHE_TTL', 120);
define('CACHE_DIR', __DIR__ . '/cache');
$GLOBALS['TFT_FETCH_DEBUG'] = [];

function isValidJsonPayload($data) {
    if (!is_string($data)) return false;
    $trimmed = trim($data);
    if ($trimmed === '') return false;
    if ($trimmed[0] === '<') return false;
    if ($trimmed[0] !== '{' && $trimmed[0] !== '[') return false;

    json_decode($trimmed, true);
    return json_last_error() === JSON_ERROR_NONE;
}

function explainJsonPayload($data) {
    if (!is_string($data)) {
        return ['ok' => false, 'reason' => 'not_string'];
    }

    $trimmed = trim($data);
    if ($trimmed === '') {
        return ['ok' => false, 'reason' => 'empty'];
    }

    if ($trimmed[0] === '<') {
        return [
            'ok' => false,
            'reason' => 'html_like',
            'preview' => substr($trimmed, 0, 300),
        ];
    }

    if ($trimmed[0] !== '{' && $trimmed[0] !== '[') {
        return [
            'ok' => false,
            'reason' => 'wrong_prefix',
            'preview' => substr($trimmed, 0, 80),
        ];
    }

    json_decode($trimmed, true);
    $err = json_last_error();
    if ($err !== JSON_ERROR_NONE) {
        return [
            'ok' => false,
            'reason' => 'json_decode_failed',
            'json_error' => json_last_error_msg(),
            'preview' => substr($trimmed, 0, 300),
            'tail' => substr($trimmed, -300),
        ];
    }

    return ['ok' => true];
}

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
        $error = curl_error($ch);
        curl_close($ch);
        $GLOBALS['TFT_FETCH_DEBUG'][] = [
            'url' => $url,
            'mode' => 'curl',
            'http_code' => $code,
            'ok' => ($data !== false && $code === 200),
            'error' => $error ?: null,
            'bytes' => is_string($data) ? strlen($data) : 0,
        ];
        return ($data !== false && $code === 200) ? $data : false;
    }
    $ctx = stream_context_create([
        'http' => [
            'timeout' => $timeout,
            'header' => "User-Agent: TFT-Helper-PHP/1.0\r\n",
        ],
    ]);
    $data = @file_get_contents($url, false, $ctx);
    $headers = $http_response_header ?? [];
    $status = is_array($headers) && isset($headers[0]) ? $headers[0] : null;
    $ok = $data !== false;
    $GLOBALS['TFT_FETCH_DEBUG'][] = [
        'url' => $url,
        'mode' => 'stream',
        'status' => $status,
        'ok' => $ok,
        'bytes' => is_string($data) ? strlen($data) : 0,
    ];
    return $data;
}

function fetchFromGithubApi($filename, $timeout = 20) {
    $url = GITHUB_API . '/' . rawurlencode($filename) . '?ref=' . rawurlencode(GITHUB_BRANCH);
    $raw = httpGet($url, $timeout);
    if ($raw === false || $raw === null || $raw === '') return false;

    $payload = json_decode($raw, true);
    if (!is_array($payload) || ($payload['encoding'] ?? '') !== 'base64' || empty($payload['content'])) {
        return false;
    }

    $decoded = base64_decode(str_replace(["\r", "\n"], '', $payload['content']), true);
    return ($decoded !== false && $decoded !== '') ? $decoded : false;
}

function cacheFilePath($filename) {
    return CACHE_DIR . '/' . str_replace('/', '_', $filename);
}

function localDataFilePath($filename) {
    if (!LOCAL_DATA_DIR) return null;
    $path = LOCAL_DATA_DIR . DIRECTORY_SEPARATOR . str_replace(['/', '\\'], DIRECTORY_SEPARATOR, $filename);
    return is_file($path) ? $path : null;
}

function fetchFromGithub($filename, $bypassCache = false) {
    $url = GITHUB_RAW . '/' . $filename;
    $cacheFile = cacheFilePath($filename);
    $localFile = localDataFilePath($filename);
    $expectsJson = preg_match('/\.json$/i', $filename) === 1;
    $timeout = $filename === 'meta-17.json' ? 20 : 10;

    if (!$bypassCache && is_file($cacheFile) && (time() - filemtime($cacheFile)) < LOCAL_CACHE_TTL) {
        $cached = file_get_contents($cacheFile);
        if (!$expectsJson || isValidJsonPayload($cached)) return $cached;
        @unlink($cacheFile);
    }

    $data = httpGet($url, $timeout);
    if ($data === false || $data === null || $data === '') {
        $data = fetchFromGithubApi($filename, $timeout);
    }

    if ($data === false || $data === null || $data === '') {
        if (is_file($cacheFile)) {
            $cached = file_get_contents($cacheFile);
            if (!$expectsJson || isValidJsonPayload($cached)) return $cached;
            @unlink($cacheFile);
        }
        if ($localFile) {
            $local = file_get_contents($localFile);
            if (!$expectsJson || isValidJsonPayload($local)) {
                return $local;
            }
        }
        return null;
    }

    if ($expectsJson && !isValidJsonPayload($data)) {
        $GLOBALS['TFT_FETCH_DEBUG'][] = [
            'url' => $url,
            'mode' => 'validation',
            'validation' => explainJsonPayload($data),
        ];
        @unlink($cacheFile);

        if ($localFile) {
            $local = file_get_contents($localFile);
            if (isValidJsonPayload($local)) {
                $GLOBALS['TFT_FETCH_DEBUG'][] = [
                    'url' => $localFile,
                    'mode' => 'local_fallback_after_invalid_remote',
                    'ok' => true,
                    'bytes' => strlen($local),
                ];
                return $local;
            }
            $GLOBALS['TFT_FETCH_DEBUG'][] = [
                'url' => $localFile,
                'mode' => 'local_fallback_after_invalid_remote',
                'ok' => false,
                'validation' => explainJsonPayload($local),
            ];
        }

        return null;
    }

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

function getFetchDebug() {
    return $GLOBALS['TFT_FETCH_DEBUG'] ?? [];
}
