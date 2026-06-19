<?php
require_once __DIR__ . '/_config.php';

$set = intval($_GET['set'] ?? 17);
$debug = isset($_GET['debug']) && $_GET['debug'] === '1';
$filename = "meta-{$set}.json";

$raw = fetchFromGithub($filename, $debug);

if ($raw === null || trim($raw) === '') {
    if ($debug) {
        sendJson(json_encode([
            'error' => 'Date indisponibile',
            'file' => $filename,
            'debug' => getFetchDebug(),
        ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), 503);
    }
    sendError('Date indisponibile');
}

$trimmed = ltrim($raw);
if ($trimmed === '' || ($trimmed[0] !== '{' && $trimmed[0] !== '[')) {
    if ($debug) {
        sendJson(json_encode([
            'error' => 'Date invalide',
            'file' => $filename,
            'preview' => substr($raw, 0, 300),
            'debug' => getFetchDebug(),
        ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), 503);
    }
    sendError('Date invalide');
}

$decoded = json_decode($raw, true);
if (json_last_error() !== JSON_ERROR_NONE) {
    if ($debug) {
        sendJson(json_encode([
            'error' => 'JSON invalid din sursa/cache',
            'file' => $filename,
            'json_error' => json_last_error_msg(),
            'preview' => substr($raw, 0, 300),
            'tail' => substr($raw, -300),
            'debug' => getFetchDebug(),
        ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), 503);
    }
    sendError('Date invalide');
}

sendJson(json_encode($decoded, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
