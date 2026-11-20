-- Fixed program; all user values are argv, never interpolated into source.
on run argv
    set wantedID to item 1 of argv
    set imagePath to item 2 of argv
    set imageFormat to item 3 of argv
    tell application "Music"
        set matches to (every file track of library playlist 1 whose persistent ID is wantedID)
        if (count of matches) is not 1 then error "Track ID is not unique"
        set targetTrack to item 1 of matches
        if (count of artworks of targetTrack) is not 0 then error "Artwork already exists; nothing replaced"
    end tell
    if imageFormat is "png" then
        set imageData to read (POSIX file imagePath) as «class PNGf»
    else if imageFormat is "jpg" then
        set imageData to read (POSIX file imagePath) as JPEG picture
    else
        error "Unsupported artwork format"
    end if
    tell application "Music" to set data of artwork 1 of targetTrack to imageData
end run
