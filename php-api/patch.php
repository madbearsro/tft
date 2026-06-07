<?php
require_once __DIR__ . '/_config.php';

$raw = fetchFromGithub('patch.json');
if ($raw === null) {
    sendJson(json_encode([
        'title' => 'TFT Patch Notes',
        'publishedAt' => null,
        'buffs' => [],
        'nerfs' => [],
        'adjusted' => [],
        'hasMidPatch' => false,
        'latestBuffs' => [],
        'latestNerfs' => [],
        'latestAdjusted' => [],
    ]));
}

$data = json_decode($raw, true);
if (!$data) sendError('Date invalide');

sendJson(json_encode($data));
