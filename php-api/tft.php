<?php
require_once __DIR__ . '/_config.php';

$set = intval($_GET['set'] ?? 17);
if ($set < 1 || $set > 99) sendError('Invalid set', 400);

$raw = fetchFromGithub("tft-set{$set}.json");
if ($raw === null) sendError('Date indisponibile', 503);

sendJson($raw);
