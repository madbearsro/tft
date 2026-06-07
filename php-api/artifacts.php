<?php
require_once __DIR__ . '/_config.php';

$set = intval($_GET['set'] ?? 17);

$raw = fetchFromGithub("artifacts-{$set}.json");
if ($raw === null) sendError('Artifacts data not available yet');

$data = json_decode($raw, true);
if (!$data) sendError('Date invalide');

function proxyArtifactIcon($path) {
    if (!$path) return null;
    $p = strtolower(str_replace('.tex', '.png', $path));
    return '/api/img.php?p=' . rawurlencode($p);
}

foreach ($data as &$item) {
    if (isset($item['icon'])) $item['icon'] = proxyArtifactIcon($item['icon']);
}
unset($item);

sendJson(json_encode($data));
