const cv = require('opencv');
const path = require('path');
const _ = require('lodash');

function sanitize(inputPath, outputPath) {

    const WHITE = [255, 255, 255];
    const BLACK = [0, 0, 0];

    // Load the image
    cv.readImage(inputPath, function(err, image) {
        if (err) { throw err; }
        if (image.width() < 1 || image.height() < 1) {
            throw new Error(`Could not open "${inputPath}". Is it really an image?`);
        }
        console.log(`Image is ${image.width()} x ${image.height()}`);

        // Crop close to ROI
        // Ignore cropping for now, ocr-tesseract does some for us
        //image = image.crop(100, 690, 780, 290);

        // Stretch image by factor of 1.5 to have less impact with filters
        const stretchRatio = 1.5;
        image.resize(image.width() * stretchRatio, image.height() * stretchRatio);

        // Blue the image a little to smooth lines
        image.gaussianBlur();

        // Run "Otsu" binary threshold algorithm to get only 0 or 255 pixel values
        let bw = image.threshold(0, 255, "Binary", "Otsu");
        const h = bw.height();
        const w = bw.width();

        // Invert image (for following calculations)
        bw.bitwiseNot(bw);

        // Location and top and bottom lines of powerball numbers
        const maxPair = {
            top:{ y: -1, val: 0 },
            bottom: { y: -1, val: 0 }
        };

        // Look at the histogram to find location of
        // top and bottom lines surrounding numbers
        const CHECK_MARGINS = 30; // assume line is in the top or bottom 30px of cropped image
        for (let row = 0; row < h; row++) {
            // Skip if it's not near the line
            if (row > CHECK_MARGINS && row < h - CHECK_MARGINS) { continue; }
            const midway = bw.height() / 2;

            const rowPixels = bw.pixelRow(row);
            const avg = _.mean(rowPixels);

            const location = row <= midway ? 'top' : 'bottom';
            if (avg > maxPair[location].val) {
                maxPair[location] = { y: row, val: avg };
            }
        }

        const cropTop = maxPair.top.y + 10;
        const cropBottom = maxPair.bottom.y - 10;


        // Crop to the newly found bounds
        bw = bw.crop(0, cropTop, w , cropBottom - cropTop);

        // Draw the rectangle (deleting "PB: " from the lines)
        bw.rectangle([560 * stretchRatio,1], [110 * stretchRatio, image.height()], BLACK, -1);

        // Invert image again
        bw.bitwiseNot(bw);

        // Output to output path
        bw.save(outputPath);
    });
}

module.exports = sanitize;
