<?php
define('GITHUB_USER', 'madbearsro');
define('GITHUB_REPO', 'tft');
define('GITHUB_BRANCH', 'main');
define('TFT_SET', 17);

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');

function fetch_github_json(string $filename): mixed {
    $url = sprintf(
        'https://raw.githubusercontent.com/%s/%s/%s/data/%s',
        GITHUB_USER, GITHUB_REPO, GITHUB_BRANCH, $filename
    );
    $ctx = stream_context_create(['http' => [
        'timeout' => 10,
        'user_agent' => 'TFT-Helper/1.0',
        'ignore_errors' => true,
    ]]);
    $body = @file_get_contents($url, false, $ctx);
    if ($body === false) return null;
    return json_decode($body, true);
}
