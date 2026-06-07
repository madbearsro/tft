<?php
require_once __DIR__ . '/_config.php';

$set = intval($_GET['set'] ?? 17);

$raw = fetchFromGithub("meta-{$set}.json");
if ($raw === null) sendError('Date indisponibile');

$data = json_decode($raw, true);
if (!$data) sendError('Date invalide');

$comps = isset($data['comps']) && is_array($data['comps'])
    ? array_map(function($comp) {
        unset($comp['source'], $comp['primarySource'], $comp['sourceUrl'],
              $comp['sources'], $comp['sourceKind'], $comp['sourceCount']);
        return $comp;
      }, $data['comps'])
    : [];

sendJson(json_encode([
    'comps' => $comps,
    'confirmedCount' => $data['confirmedCount'] ?? 0,
]));
