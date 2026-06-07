<?php
require_once __DIR__ . '/_config.php';

$region = preg_replace('/[^a-z0-9]/', '', strtolower($_GET['region'] ?? 'kr'));
$set    = intval($_GET['set'] ?? 17);

$allowed = ['euw', 'na', 'kr', 'br', 'eune', 'jp', 'lan', 'las', 'oce', 'ru', 'tr'];
if (!in_array($region, $allowed)) sendError('Invalid region', 400);

$raw = fetchFromGithub("challenger-{$region}-{$set}.json");
if ($raw === null) sendError('Challenger data not available yet');

$data = json_decode($raw, true);
if (!$data) sendError('Date invalide');

$strip_top = ['source', 'sources', 'patchStartTime', 'profiles',
              'hasIndividualMatches', 'individualProfiles', 'aggregateUsed',
              'aggregateMatches', 'aggregateProfiles', 'opggScannedMatches',
              'opggAggregateMatches', 'opggAggregateProfiles', 'opggScannedProfiles'];
foreach ($strip_top as $key) unset($data[$key]);

$strip_comp = ['source', 'primarySource', 'sourceKind', 'sourceCount', 'sources'];
if (isset($data['challengerComps']) && is_array($data['challengerComps'])) {
    $data['challengerComps'] = array_map(function($comp) use ($strip_comp) {
        foreach ($strip_comp as $key) unset($comp[$key]);
        return $comp;
    }, $data['challengerComps']);
}

if (isset($data['traitStats']) && is_array($data['traitStats'])) {
    $data['traitStats'] = array_map(function($t) {
        unset($t['source']);
        return $t;
    }, $data['traitStats']);
}

sendJson(json_encode($data));
