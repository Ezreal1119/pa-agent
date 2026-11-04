/** Deterministic pseudo-localization for maintenance tests, without copying source-language prose. */
export function mockTranslated(text: string, language: string): string {
    const alphabet = "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥天地人和";
    return text.split(/(__CKD_LITERAL_[0-9a-f]{12}_\d+__)/gu).map(part => {
        if (part.startsWith("__CKD_LITERAL_")) return part;
        if (language !== "中文") return part.replace(/\p{Script=Han}+/gu, "Translated");
        return part.replace(/\b[A-Z]{2,}(?:-[A-Z0-9]+)*\b|\b[A-Za-z]{3,}\b/gu, word => {
            if (/^[A-Z]{2,}/u.test(word) || word === "revision") return word;
            return [...word.toLowerCase()].map(char => alphabet[char.charCodeAt(0) - 97] ?? char).join("");
        });
    }).join("");
}
