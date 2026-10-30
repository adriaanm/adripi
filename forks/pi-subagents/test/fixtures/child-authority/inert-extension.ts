// Inert required-child-extension entrypoint for launch fixtures.
//
// Registration canonicalizes required extension paths to real files, so the guarded-launch tests need an
// actual file path. This one registers nothing and has no host privileges: it stands in for the pi-sbx /
// pi-guardian entrypoints only as a resolvable path, never as a consumer or authority source.
export default function inertLaunchFixtureExtension(): void {}
