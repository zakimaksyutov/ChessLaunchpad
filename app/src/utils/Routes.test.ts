import { describe, it, expect } from 'vitest';
import { isExplorerRoute, isExplorerHash } from './Routes';

describe('isExplorerRoute', () => {
    it('matches the exact /explorer route', () => {
        expect(isExplorerRoute('/explorer')).toBe(true);
    });

    it('matches nested /explorer/... routes', () => {
        expect(isExplorerRoute('/explorer/foo')).toBe(true);
        expect(isExplorerRoute('/explorer/foo/bar')).toBe(true);
    });

    it('matches /explorer with a query string', () => {
        expect(isExplorerRoute('/explorer?x=1')).toBe(true);
    });

    it('does NOT match sibling routes that share the prefix', () => {
        expect(isExplorerRoute('/explorer-stats')).toBe(false);
        expect(isExplorerRoute('/explorerz')).toBe(false);
        expect(isExplorerRoute('/explorer2')).toBe(false);
    });

    it('does NOT match unrelated routes', () => {
        expect(isExplorerRoute('/')).toBe(false);
        expect(isExplorerRoute('/training')).toBe(false);
        expect(isExplorerRoute('/settings')).toBe(false);
        expect(isExplorerRoute('')).toBe(false);
    });
});

describe('isExplorerHash', () => {
    it('matches hash-prefixed explorer routes', () => {
        expect(isExplorerHash('#/explorer')).toBe(true);
        expect(isExplorerHash('#/explorer/foo')).toBe(true);
        expect(isExplorerHash('#/explorer?x=1')).toBe(true);
    });

    it('does NOT match hash-prefixed sibling routes', () => {
        expect(isExplorerHash('#/explorer-stats')).toBe(false);
        expect(isExplorerHash('#/explorerz')).toBe(false);
    });

    it('does NOT match strings without a leading #', () => {
        expect(isExplorerHash('/explorer')).toBe(false);
        expect(isExplorerHash('explorer')).toBe(false);
        expect(isExplorerHash('')).toBe(false);
    });
});
