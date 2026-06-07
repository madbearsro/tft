<?php
require_once __DIR__ . '/_config.php';

$lang = preg_replace('/[^a-z]/', '', strtolower($_GET['lang'] ?? 'en'));
if (!in_array($lang, ['ro', 'en'])) sendError('Invalid lang', 400);

$data = fetchFromGithub("locale-{$lang}.json");
if ($data === null) sendError('Locale data not available yet');

sendJson($data);
