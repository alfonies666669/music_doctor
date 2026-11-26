-- Explicit replacement after a verified file write. User values are argv only.
on run argv
    set wantedID to item 1 of argv
    set imagePath to item 2 of argv
    set imageFormat to item 3 of argv
    set expectedFile to (POSIX file (item 4 of argv)) as alias
    if imageFormat is "png" then
        set imageData to «event rdwrread» (POSIX file imagePath) given «class as  »:«class PNGf»
    else if imageFormat is "jpg" then
        set imageData to «event rdwrread» (POSIX file imagePath) given «class as  »:«class JPEG»
    else
        error "Unsupported artwork format"
    end if
    tell application "/System/Applications/Music.app"
        set matches to (every file track of library playlist 1 whose persistent ID is wantedID)
        if (count of matches) is not 1 then error "Track ID is not unique"
        set targetTrack to item 1 of matches
        if (location of targetTrack) is not expectedFile then error "Music entry points to a different file"
        set pictures to artworks of targetTrack
        if (count of pictures) > 1 then error "Multiple Music pictures (" & (count of pictures) & ") for " & wantedID & "; review manually"
        set data of artwork 1 of targetTrack to imageData
    end tell
end run
