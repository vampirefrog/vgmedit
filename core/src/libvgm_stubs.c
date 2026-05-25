/*
 * Stubs for libvgm's optional charset-conversion symbols.
 *
 * We disable UTIL_CHARSET_CONV when building libvgm so iconv isn't a
 * dependency, but the VGMPlayer still references CPConv_* for GD3 tag
 * conversion. Provide a pass-through implementation: tags come out as
 * raw bytes (good enough — we don't display GD3 in the editor yet).
 */
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include "stdtype.h"

typedef struct _codepage_conversion CPCONV;

UINT8 CPConv_Init(CPCONV **retCPC, const char *cpFrom, const char *cpTo) {
    (void)cpFrom; (void)cpTo;
    if (retCPC) *retCPC = NULL;
    return 0x00;
}

void CPConv_Deinit(CPCONV *cpc) {
    (void)cpc;
}

UINT8 CPConv_StrConvert(CPCONV *cpc, size_t *outSize, char **outStr,
                        size_t inSize, const char *inStr) {
    (void)cpc;
    if (inSize == 0 && inStr) inSize = strlen(inStr) + 1;
    if (!outStr) return 0x01;
    if (*outStr == NULL) {
        *outStr = (char *)malloc(inSize);
        if (!*outStr) { if (outSize) *outSize = 0; return 0x01; }
        if (outSize) *outSize = inSize;
    } else if (outSize && *outSize < inSize) {
        return 0x01;
    }
    if (inStr) memcpy(*outStr, inStr, inSize);
    else if (inSize > 0) memset(*outStr, 0, inSize);
    if (outSize) *outSize = inSize;
    return 0x00;
}
