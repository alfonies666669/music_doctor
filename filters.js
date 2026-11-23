/* Read-only snapshot selection. User expressions are data, never executable code. */
var MusicFilters = (function () {
    'use strict';
    var textFields = ['name', 'artist', 'album', 'albumArtist', 'genre'];
    var sortFields = textFields.concat(['favorite', 'duration']);
    var textOps = ['eq', 'contains', 'startsWith', 'endsWith'];
    var numberOps = ['eq', 'gt', 'gte', 'lt', 'lte'];
    function fail(message) { throw new Error(message); }
    function object(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
    function key(s) { return s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim(); }
    function text(value, allowEmpty) {
        if (typeof value !== 'string' || value.length > 2000 || /[\x00-\x1f]/.test(value) || (!allowEmpty && !value.trim())) fail('Filter text must be a nonempty string (except eq can match an empty field)');
    }
    function duration(value) {
        if (typeof value !== 'string' || !value.trim()) fail('Duration must be nonnegative seconds or M:SS / H:MM:SS');
        var s = value.trim(), result;
        if (/^\d+(?:\.\d+)?$/.test(s)) result = Number(s);
        else {
            var m = /^(?:(\d+):)?(\d+):(\d{2}(?:\.\d+)?)$/.exec(s);
            if (!m || Number(m[3]) >= 60 || (m[1] !== undefined && Number(m[2]) >= 60)) fail('Duration must be nonnegative seconds or M:SS / H:MM:SS');
            result = Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        }
        if (!isFinite(result) || result < 0) fail('Duration must be finite and nonnegative');
        return result;
    }
    function validate(expression) {
        var nodes = 0;
        function visit(node, depth) {
            if (!object(node) || Object.keys(node).length !== 1) fail('Each filter node must contain exactly one field or all/any/not');
            if (++nodes > 1024 || depth > 16) fail('Filter is too large or nested too deeply');
            var field = Object.keys(node)[0], value = node[field];
            if (field === 'all' || field === 'any') {
                if (!Array.isArray(value) || !value.length) fail(field + ' must contain a nonempty array');
                value.forEach(function (child) { visit(child, depth + 1); });
            } else if (field === 'not') visit(value, depth + 1);
            else if (field === 'favorite') {
                if (typeof value !== 'boolean') fail('favorite must be true or false');
            } else if (textFields.indexOf(field) >= 0 || field === 'duration') {
                if (!object(value) || !Object.keys(value).length) fail(field + ' needs a comparison object');
                Object.keys(value).forEach(function (op) {
                    if (field === 'duration') {
                        if (numberOps.indexOf(op) < 0 || typeof value[op] !== 'number' || !isFinite(value[op]) || value[op] < 0) fail('duration accepts eq/gt/gte/lt/lte with finite nonnegative seconds');
                    } else {
                        if (textOps.indexOf(op) < 0) fail('Text comparison must be eq/contains/startsWith/endsWith');
                        text(value[op], op === 'eq');
                    }
                });
            } else fail('Unsupported filter field: ' + field);
        }
        visit(expression, 0);
        return expression;
    }
    function fields(expression) {
        var found = [];
        function visit(node) {
            if (!node) return;
            var field = Object.keys(node)[0];
            if (field === 'all' || field === 'any') node[field].forEach(visit);
            else if (field === 'not') visit(node[field]);
            else if (found.indexOf(field) < 0) found.push(field);
        }
        visit(expression); return found;
    }
    // null means unavailable data. NOT unknown remains unknown, never true.
    function evaluate(expression, row) {
        if (!expression) return true;
        var field = Object.keys(expression)[0], expected = expression[field], value = row[field];
        if (field === 'not') { var child = evaluate(expected, row); return child === null ? null : !child; }
        if (field === 'all' || field === 'any') {
            var unknown = false;
            for (var i = 0; i < expected.length; i++) {
                var result = evaluate(expected[i], row);
                if (field === 'all' && result === false) return false;
                if (field === 'any' && result === true) return true;
                if (result === null) unknown = true;
            }
            return unknown ? null : field === 'all';
        }
        if (field === 'favorite') return typeof value === 'boolean' ? value === expected : null;
        if (field === 'duration' && (typeof value !== 'number' || !isFinite(value) || value < 0)) return null;
        if (field !== 'duration' && typeof value !== 'string') return null;
        return Object.keys(expected).every(function (op) {
            var wanted = expected[op];
            if (field !== 'duration') {
                var actualText = key(value), wantedText = key(wanted);
                if (op === 'eq') return actualText === wantedText;
                if (op === 'contains') return actualText.indexOf(wantedText) >= 0;
                if (op === 'startsWith') return actualText.indexOf(wantedText) === 0;
                return actualText.slice(-wantedText.length) === wantedText;
            }
            if (op === 'eq') return value === wanted;
            if (op === 'gt') return value > wanted;
            if (op === 'gte') return value >= wanted;
            if (op === 'lt') return value < wanted;
            return value <= wanted;
        });
    }
    function sort(rows, field, descending) {
        if (!field) return rows.slice();
        if (sortFields.indexOf(field) < 0) fail('Unsupported sort field: ' + field);
        return rows.map(function (row, index) { return {row: row, index: index}; }).sort(function (a, b) {
            function value(row) {
                var v = row[field];
                if (textFields.indexOf(field) >= 0) return typeof v === 'string' && v.trim() ? key(v) : null;
                if (field === 'favorite') return typeof v === 'boolean' ? Number(v) : null;
                return typeof v === 'number' && isFinite(v) && v >= 0 ? v : null;
            }
            var av = value(a.row), bv = value(b.row);
            if (av === null || bv === null) return av === bv ? a.index - b.index : av === null ? 1 : -1;
            var compared = av < bv ? -1 : av > bv ? 1 : 0;
            return compared ? compared * (descending ? -1 : 1) : a.index - b.index;
        }).map(function (item) { return item.row; });
    }
    function combine(expressions) { return expressions.length === 0 ? null : expressions.length === 1 ? expressions[0] : {all: expressions}; }
    function inline(field, value) {
        text(value, false);
        if (textFields.indexOf(field) < 0) fail('Inline expressions need a text field');
        var tokens = [], buffer = '', hasOperators = false;
        function flush() {
            if (buffer.trim()) tokens.push({type: 'term', value: buffer.trim(), quoted: false});
            buffer = '';
        }
        function boundary(c) { return c === undefined || /[\s()!&|]/.test(c); }
        for (var i = 0; i < value.length;) {
            var c = value[i], pair = value.slice(i, i + 2);
            if (c === '"') {
                flush(); i++;
                var literal = '', closed = false;
                while (i < value.length) {
                    if (value[i] === '"') { closed = true; i++; break; }
                    if (value[i] === '\\' && (value[i + 1] === '"' || value[i + 1] === '\\')) i++;
                    literal += value[i++];
                }
                if (!closed) fail('Unclosed double-quoted term in filter expression');
                text(literal, false);
                tokens.push({type: 'term', value: literal, quoted: true});
            } else if (c === '(' || c === ')') {
                flush(); tokens.push({type: c}); i++;
            } else if (pair === '||' || pair === '&&' || (c === '!' && boundary(value[i - 1]))) {
                flush(); tokens.push({type: pair === '||' ? 'OR' : pair === '&&' ? 'AND' : 'NOT'});
                hasOperators = true; i += c === '!' ? 1 : 2;
            } else {
                var operator = null;
                ['AND', 'OR', 'NOT'].some(function (word) {
                    if (value.slice(i, i + word.length) === word && boundary(value[i - 1]) && boundary(value[i + word.length])) { operator = word; return true; }
                    return false;
                });
                if (operator) { flush(); tokens.push({type: operator}); hasOperators = true; i += operator.length; }
                else { buffer += c; i++; }
            }
        }
        flush();
        function leaf(term) { var node = {}; node[field] = {}; node[field][field === 'genre' ? 'eq' : 'contains'] = term; return node; }
        if (!hasOperators) {
            // Preserve existing literal names, including ordinary parentheses and apostrophes.
            return leaf(tokens.length === 1 && tokens[0].quoted ? tokens[0].value : value);
        }
        var position = 0;
        function type() { return position < tokens.length ? tokens[position].type : 'end'; }
        function unary(depth) {
            if (depth > 16) fail('Filter is nested too deeply');
            if (type() === 'NOT') { position++; return {not: unary(depth + 1)}; }
            if (type() === '(') {
                position++; var group = or(depth + 1);
                if (type() !== ')') fail('Missing closing parenthesis in filter expression');
                position++; return group;
            }
            if (type() !== 'term') fail('Expected a name or quoted term, found ' + type());
            return leaf(tokens[position++].value);
        }
        function and(depth) {
            var nodes = [unary(depth)];
            while (type() === 'AND' || type() === 'NOT') {
                // Bushido NOT Fler is a shorthand for Bushido AND NOT Fler.
                if (type() === 'AND') position++;
                nodes.push(unary(depth));
            }
            return nodes.length === 1 ? nodes[0] : {all: nodes};
        }
        function or(depth) {
            var nodes = [and(depth)];
            while (type() === 'OR') { position++; nodes.push(and(depth)); }
            return nodes.length === 1 ? nodes[0] : {any: nodes};
        }
        var expression = or(0);
        if (position !== tokens.length) fail('Unexpected ' + type() + '; use AND/OR between terms and check parentheses');
        return validate(expression);
    }
    function parse(argv) {
        var positional = [], expressions = [], used = {}, scope = null, sortBy = null, descending = false, show = 20;
        var options = ['--genre', '--name', '--title', '--artist', '--album', '--album-artist', '--favorite', '--min-duration', '--max-duration', '--playlist', '--sort', '--show'];
        var min = null, max = null;
        function once(flag) { if (used[flag]) fail('Repeated option: ' + flag + '; combine names with AND/OR/NOT inside one quoted argument'); used[flag] = true; }
        for (var i = 0; i < argv.length; i++) {
            var flag = argv[i];
            if (flag === '--all') { once('scope'); scope = {kind: 'all', value: '--all'}; continue; }
            if (flag === '--desc') { once(flag); descending = true; continue; }
            if (flag.slice(0, 2) !== '--') { positional.push(flag); continue; }
            if (options.indexOf(flag) < 0) fail('Unknown snapshot option: ' + flag);
            once(flag === '--playlist' ? 'scope' : flag === '--title' ? '--name' : flag);
            if (++i >= argv.length || argv[i].slice(0, 2) === '--') fail('Missing value for ' + flag);
            var value = argv[i];
            if (flag === '--playlist') { text(value, false); scope = {kind: 'playlist', value: value}; }
            else if (flag === '--show') {
                if (value === 'all') show = null;
                else if (/^\d+$/.test(value) && Number.isSafeInteger(Number(value))) show = Number(value);
                else fail('--show must be a nonnegative integer or all');
            }
            else if (flag === '--sort') { if (sortFields.indexOf(value) < 0) fail('--sort accepts ' + sortFields.join(', ')); sortBy = value; }
            else if (flag === '--favorite') {
                if (value !== 'true' && value !== 'false') fail('--favorite must be true or false');
                expressions.push({favorite: value === 'true'});
            } else if (flag === '--min-duration' || flag === '--max-duration') {
                var seconds = duration(value), cmp = {};
                cmp[flag === '--min-duration' ? 'gte' : 'lte'] = seconds;
                expressions.push({duration: cmp});
                if (flag === '--min-duration') min = seconds; else max = seconds;
            } else {
                text(value, false);
                var field = flag === '--title' ? 'name' : flag === '--album-artist' ? 'albumArtist' : flag.slice(2);
                expressions.push(inline(field, value));
            }
        }
        if (min !== null && max !== null && min > max) fail('Minimum duration exceeds maximum duration');
        if (descending && !sortBy) fail('--desc requires --sort');
        if (positional.length === 2) { if (scope) fail('Use one playlist/all scope'); scope = {kind: 'playlist', value: positional.shift()}; text(scope.value, false); }
        if (positional.length > 1 || positional.some(function (v) { return !v; })) fail('Use snapshot [playlist or filters] [output.json]');
        if (positional.length === 1 && !scope && !expressions.length && !/\.json$/i.test(positional[0])) {
            scope = {kind: 'playlist', value: positional.shift()}; text(scope.value, false);
        }
        var expression = combine(expressions); if (expression) validate(expression);
        scope = scope || {kind: 'all', value: '--all'};
        var onlyGenre = expressions.length === 1 && Object.keys(expressions[0])[0] === 'genre' && scope.kind === 'all';
        return {kind: onlyGenre ? 'genre' : expression ? 'filter' : scope.kind,
            value: onlyGenre ? expressions[0].genre.eq : scope.value, scope: scope, filter: expression,
            sort_by: sortBy, descending: descending, show_limit: show, output: positional.length ? positional[0] : null};
    }
    return {validate: validate, fields: fields, evaluate: evaluate, sort: sort, inline: inline, parse: parse, duration: duration};
}());
if (typeof module !== 'undefined') module.exports = MusicFilters;
