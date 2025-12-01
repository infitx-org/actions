const { add, isPalindrome } = require('./index');
const { describe, test, expect } = require('@jest/globals');

describe('add', () => {
    test('adds two positive numbers', () => {
        expect(add(2, 3)).toBe(5);
    });

    test('adds positive and negative number', () => {
        expect(add(5, -2)).toBe(3);
    });

    test('adds two negative numbers', () => {
        expect(add(-4, -6)).toBe(-10);
    });

    test('adds zero', () => {
        expect(add(0, 7)).toBe(7);
        expect(add(0, 0)).toBe(0);
    });
});

describe('isPalindrome', () => {
    test('returns true for a simple palindrome', () => {
        expect(isPalindrome('madam')).toBe(true);
    });

    test('returns true for a palindrome with spaces and punctuation', () => {
        expect(isPalindrome('A man, a plan, a canal: Panama')).toBe(true);
    });

    test('returns false for a non-palindrome', () => {
        expect(isPalindrome('hello')).toBe(false);
    });

    test('returns true for an empty string', () => {
        expect(isPalindrome('')).toBe(true);
    });

    test('returns true for a palindrome with mixed case', () => {
        expect(isPalindrome('RaceCar')).toBe(true);
    });

    test('returns true for a palindrome with underscores and symbols', () => {
        expect(isPalindrome('Able_was I, ere I saw Elba!')).toBe(true);
    });
});