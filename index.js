/**
 * Example function to add two numbers.
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function add(a, b) {
    return a + b;
}

/**
 * Example function to check if a string is a palindrome.
 * @param {string} str
 * @returns {boolean}
 */
function isPalindrome(str) {
    const normalized = str.replace(/[\W_]/g, '').toLowerCase();
    return normalized === normalized.split('').reverse().join('');
}

// Export functions for unit testing
module.exports = {
    add,
    isPalindrome,
};
