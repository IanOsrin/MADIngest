#!/bin/bash

SOURCE="/Users/fmserver/Documents/Vision.localized/gallo-music-files-wavs/CCA DDEX/20260618160011764"
DEST="/Users/fmserver/Documents/Vision.localized/gallo-music-files-wavs/CCA DDEX/20260618160011764 Artwork"

find "$SOURCE" -type f -iname "*.jpg" | while read -r file; do
    mv "$file" "$DEST/"
    echo "Moved: $(basename "$file")"
done

echo "Done."
