<?php
require_once '_config.php';

$data = fetch_github_json('challenger-' . TFT_REGION . '-' . TFT_SET . '.json');

if ($data === null) {
    http_response_code(503);
    echo json_encode(['error' => 'Date indisponibile']);
    exit;
}

echo json_encode($data);
