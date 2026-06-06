<?php
require_once '_config.php';

$allowed = ['ro', 'en', 'fr', 'de', 'es', 'it', 'pl'];
$lang = $_GET['lang'] ?? 'en';
if (!in_array($lang, $allowed, true)) $lang = 'en';

$data = fetch_github_json('locale-' . $lang . '.json');

if ($data === null) {
    http_response_code(503);
    echo json_encode(['error' => 'Locale indisponibil']);
    exit;
}

echo json_encode($data);
