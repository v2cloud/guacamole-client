
#include <stdio.h>
#include <png.h>

#include "proxy.h"

struct guac_write_info {
    int client_fd;
};

void guac_write_png(png_structp png, png_bytep data, png_size_t length) {

    int client_fd;

    client_fd = ((struct guac_write_info*) png->io_ptr)->client_fd;

    /* TODO: */
    /* write_base64(client_fd, data, length); */

}

void guac_write_flush(png_structp png) {
    printf("HERE!\n");
}

void proxy(int client_fd) {

    struct guac_write_info write_info;

    png_structp png;
    png_infop png_info;
    png_byte** png_rows;
    png_byte* row;

    int x, y;

    /* Set up PNG writer */
    png = png_create_write_struct(PNG_LIBPNG_VER_STRING, NULL, NULL, NULL);
    if (!png) {
        perror("Error initializing libpng write structure");
        return;
    }

    png_info = png_create_info_struct(png);
    if (!png_info) {
        perror("Error initializing libpng info structure");
        png_destroy_write_struct(&png, NULL);
        return;
    }

    /* Set error handler */
    if (setjmp(png_jmpbuf(png))) {
        perror("Error setting handler");
        png_destroy_write_struct(&png, &png_info);
        return;
    }

    /* Set PNG IHDR */
    png_set_IHDR(
            png,
            png_info,
            100, /* width */
            100, /* height */
            8,
            PNG_COLOR_TYPE_RGB,
            PNG_INTERLACE_NONE,
            PNG_COMPRESSION_TYPE_DEFAULT,
            PNG_FILTER_TYPE_DEFAULT
    );

    /* Allocate rows for PNG */
    png_rows = png_malloc(png, 100 /* height */ * sizeof(png_byte*));

    write_info.client_fd = client_fd;
    png_set_write_fn(png, &write_info, guac_write_png, guac_write_flush);

    /*** CREATE AND WRITE IMAGE ***/

    /* For now, generate test white image */
    for (y=0; y<100 /* height */; y++) {

        row = (png_byte*) png_malloc(png, sizeof(png_byte) * 3 * 100 /* width */);
        png_rows[y] = row;

        for (x=0; x<100 /* width */; x++) {
            *row++ = 0xFF;
            *row++ = 0xFF;
            *row++ = 0xFF;
        }
    }


    png_set_rows(png, png_info, png_rows);
    png_write_png(png, png_info, PNG_TRANSFORM_IDENTITY, NULL);

    write(client_fd, "name:hello;size:1024,768;error:Test finished.;", 46);

    /* Free PNG data */
    for (y = 0; y<100 /* height */; y++)
        png_free(png, png_rows[y]);
    png_free(png, png_rows);

    png_destroy_write_struct(&png, &png_info);

}
